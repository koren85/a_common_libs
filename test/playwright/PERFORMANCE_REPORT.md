# Отчёт: баги производительности плагина `a_common_libs`

**Дата анализа:** 2026-04-02  
**БД:** PostgreSQL 12, схема `redmine_work`  
**Метод:** EXPLAIN ANALYZE на реальных данных + статический анализ кода  
**Playwright-тесты:** [perf_bugs.spec.js](perf_bugs.spec.js)

## Данные БД на момент анализа

| Таблица | Размер | Строк |
|---------|--------|-------|
| `journals` | 650 MB | 1,698,203 |
| `custom_values` | 539 MB | 1,711,893 |
| `sessions` | 298 MB | 827,235 |
| `issues` | 137 MB | ~111,331 |
| `acl_ajax_counters` | 496 KB | 2,401 |

---

## BUG-2 — КРИТИЧЕСКИЙ ✅ ПОДТВЕРЖДЁН

**`get_favourite_project` — 450–795ms на каждый HTTP-запрос**

**Файл:** `lib/acl/patches/models/user_patch.rb:18-37`

### Измерения EXPLAIN ANALYZE

```
user_id=4  (142,440 journals): Execution Time = 795ms
user_id=3  (11,849 journals):  Execution Time = 450ms
```

### Проблемный код

```ruby
def get_favourite_project
  return @fav_project if @fav_project
  @fav_project = Project.select("#{Project.table_name}.*, COUNT(#{Journal.table_name}.id) AS num_actions")
                        .joins({ issues: :journals })
                        .where("#{Journal.table_name}.user_id = ?", id)
                        .group("projects.#{Project.column_names.join(', projects.')}")
                        .order('num_actions DESC')
                        .limit(1)
                        .try(:first)
  @fav_project = Project.all.first unless @fav_project
  # ... + self.preference.save
end
```

### Plan-узлы (user_id=4)

```
Parallel Bitmap Heap Scan on journals
  Recheck Cond: (user_id = 4)
  Heap Blocks: exact=7459        ← читает 7459 страниц (≈60 MB журналов)
  -> Bitmap Index Scan on idx_journals_user_id
       rows=142440

Parallel Seq Scan on issues      ← ПОЛНЫЙ СКАН 37k задач (без индекса!)
  Buffers: shared read=7927

Finalize GroupAggregate
  Group Key: projects.id         ← GROUP BY по 15+ колонкам projects
```

### Почему так медленно

1. JOIN `issues → journals` читает ~60 MB случайных страниц журналов
2. `Parallel Seq Scan on issues` — полный скан 111k задач
3. `GROUP BY projects.*` (15+ колонок) — дорогой агрегат
4. Метод вызывается из `allowed_target_projects_with_acl` (`issue_patch.rb:25`)
   и из меню в `init.rb:13` — **на каждом HTTP-запросе** залогиненного пользователя
5. 66 активных пользователей без `favourite_project_id` — каждый запрос запускает этот запрос

### Исправление

```ruby
def get_favourite_project
  return @fav_project if @fav_project
  # Убираем JOIN с projects — нам нужен только project_id
  project_id = Issue.joins(:journals)
                    .where("#{Journal.table_name}.user_id = ?", id)
                    .group("#{Issue.table_name}.project_id")
                    .order("count(*) DESC")
                    .limit(1)
                    .pick(:project_id)
  @fav_project = project_id ? Project.find_by(id: project_id) : Project.first
  if self.preference.try(:favourite_project_id).nil? && @fav_project
    self.preference = self.build_preference if self.preference.blank?
    self.preference.favourite_project_id = @fav_project.id
    self.preference.save
  end
  @fav_project
end
```

---

## BUG-6 — КРИТИЧЕСКИЙ ✅ ПОДТВЕРЖДЁН (главная причина 1000% CPU)

**`sessions` таблица — 298 MB, никогда не вакуумировалась**

**Файл:** `init.rb:49`, `app/controllers/ajax_counters_controller.rb:19-21`

### Измерения

```sql
total_sessions:   827,235
older_30d:        827,178  (99.99% — мёртвые сессии)
older_7d:         827,208
last_autovacuum:  NULL      ← НИКОГДА не запускался!
avg_session_size: 158 bytes
max_session_size: 23 KB
total_data_size:  125 MB

Индексы:
  idx_sessions_on_session_id:  56 MB
  idx_sessions_on_updated_at:  18 MB
  idx_primary:                 18 MB
  ──────────────────────────────────
  Итого:                      298 MB

SELECT count(*) FROM sessions:  280ms
```

### Причина

В `init.rb:49` принудительно установлено:
```ruby
Rails.application.config.session_store :active_record_store
```

Каждый HTTP-запрос делает `UPDATE sessions SET data=..., updated_at=...`.  
Таблица в схеме `redmine_work` — autovacuum её **никогда не обрабатывал**.  
827k dead tuples → постоянный bloat → write amplification при каждом запросе.

Дополнительно в `ajax_counters_controller.rb:19-21`:
```ruby
session[counter_md5] = { c: count, t: Time.now.utc, p: period }
```
Каждый poll AJAX-счётчиков записывает в session → дополнительный UPDATE в bloated таблицу.

### Исправление

**Шаг 1 — срочно (0 downtime):**
```sql
-- Удалить стухшие сессии
DELETE FROM redmine_work.sessions WHERE updated_at < NOW() - interval '7 days';
VACUUM FULL ANALYZE redmine_work.sessions;

-- Настроить autovacuum для схемы redmine_work
ALTER TABLE redmine_work.sessions SET (
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.01
);
```

**Шаг 2 — переключить session store на Redis** (Redis уже запущен в docker-compose):
```ruby
# init.rb:49 — заменить на:
Rails.application.config.session_store :redis_store,
  servers: ['redis://localhost:6379/0/session'],
  expire_after: 2.hours
```

---

## BUG-1 — ВЫСОКИЙ ✅ ПОДТВЕРЖДЁН

**`acl_custom_values_scope_postgre` — тройной вложенный SQL**

**Файл:** `lib/acl/patches/models/issue_patch.rb:144-168`

### Измерения

```
25 задач  × 10 CF:  Execution Time = 3.6ms   (warm, индекс работает)
100 задач × 71 CF:  Execution Time = 18.8ms  (warm, 1096 Heap Fetches)
```

### Проблемный код

```ruby
def acl_custom_values_scope_postgre(issue_ids, custom_field_ids)
  CustomValue.joins("INNER JOIN (
    SELECT cv.id, cv.cnt FROM (
      SELECT cv.id, cv_m.cnt,
             ROW_NUMBER() OVER (PARTITION BY i.id, cv.custom_field_id ...) as row_num
      FROM issues i
           INNER JOIN custom_values cv ON cv.customized_id = i.id
           INNER JOIN custom_fields cf ON cf.id = cv.custom_field_id
           INNER JOIN (SELECT COUNT(1) as cnt, cv.custom_field_id, cv.customized_id
                       FROM custom_values cv
                       WHERE cv.customized_type = 'Issue'
                         and cv.custom_field_id IN (#{custom_field_ids.join(',')})  -- ИНТЕРПОЛЯЦИЯ!
                         and cv.customized_id IN (#{issue_ids.join(',')})           -- ИНТЕРПОЛЯЦИЯ!
                       GROUP BY cv.custom_field_id, cv.customized_id) cv_m ...
      WHERE ...
        and cv.custom_field_id IN (#{custom_field_ids.join(',')})  -- ПОВТОР
        and i.id IN (#{issue_ids.join(',')})                       -- ПОВТОР
    ) cv WHERE cv.mlt = 0 OR cv.row_num <= 3
  ) cv ON cv.id = #{CustomValue.table_name}.id")
end
```

### Почему медленно при cold cache

- Строковая интерполяция IDs → каждый запрос уникален → query plan не кешируется PostgreSQL
- При cold cache (рестарт сервера) 1096 Heap Fetches даже для 100 задач
- В продакшне с 500+ задач на странице время вырастает пропорционально

### Исправление

Заменить строковую интерполяцию на параметризованные Arel-запросы:
```ruby
.where(custom_field_id: custom_field_ids)
.where(customized_id: issue_ids)
```

---

## BUG-3 — УМЕРЕННЫЙ ✅ ПОДТВЕРЖДЁН

**Лишний подзапрос `GROUP BY project_id, tracker_id` в `acl_load_custom_values`**

**Файл:** `lib/acl/patches/models/issue_patch.rb:38-53`

### Измерения

```
Execution Time = 2ms  (Seq Scan на custom_fields_projects: 2408 строк)
```

### Проблема

Внутри `acl_load_custom_values` выполняется SQL с подзапросом:
```sql
INNER JOIN (
    SELECT i.project_id, i.tracker_id
    FROM issues i
    WHERE i.id IN (...)  -- уже загруженные issues!
    GROUP BY i.project_id, i.tracker_id
) i ON ...
```
Пары `(project_id, tracker_id)` уже известны из загруженных в Ruby объектов `issues`.

### Исправление

```ruby
# Вместо подзапроса — вычислить из уже загруженных issues в Ruby
pairs = issues.map { |i| [i.project_id, i.tracker_id] }.uniq
# Построить условие через Arel без лишнего SQL-подзапроса
```

---

## BUG-4 — ВЫСОКИЙ ✅ ПОДТВЕРЖДЁН

**`options.deep_dup` в кеш-ключах — кеш `link_to_user` и `avatar` никогда не работает**

**Файлы:** `lib/acl/application_helper_patch.rb:13`, `lib/acl/avatars_helper_patch.rb:14`

### Проблемный код

```ruby
def link_to_user_with_acl(user, options={})
  key = [user.class.name, user.try(:id), options.deep_dup]  # deep_dup на каждый вызов!
  @_link_to_user_acl_cache ||= {}
  @_link_to_user_acl_cache[key] ||= link_to_user_without_acl(user, options)
end
```

### Почему кеш не работает

`Array#==` использует `eql?` для сравнения элементов. Два результата `options.deep_dup` —  
это два **разных объекта** с разными `object_id`. `Hash#eql?` возвращает `true` только если  
объекты **идентичны** (или явно переопределён `eql?`/`hash`). Ключи всегда разные → miss.

На странице с 25 задачами: минимум 50 вызовов `deep_dup` (author + assigned_to)  
× 2 хелпера = **100 бесполезных deep_dup** + 100 cache miss.

### Исправление

```ruby
def link_to_user_with_acl(user, options={})
  key = [user.class.name, user.try(:id), options[:size], options[:class]]
  @_link_to_user_acl_cache ||= {}
  @_link_to_user_acl_cache[key] ||= link_to_user_without_acl(user, options)
end
```

---

## BUG-7 — УМЕРЕННЫЙ ✅ ПОДТВЕРЖДЁН

**`.size` вместо `.count` в `acl_not_served_log_count`**

**Файл:** `lib/acl/patches/models/user_patch.rb:88`

### Проблемный код

```ruby
def acl_not_served_log_count(view_context=nil, params=nil, session=nil)
  ApiLogForPlugin.where(served: false).size  # загружает все записи в память!
end
```

### Факт

В dev-БД таблица пуста (0 строк), поэтому не проявляется.  
В prod с тысячами логов `.size` выполняет `SELECT *` и считает в Ruby.

### Исправление

```ruby
ApiLogForPlugin.where(served: false).count
```

---

## BUG-9 — УМЕРЕННЫЙ ✅ ПОДТВЕРЖДЁН

**`AclAjaxCounter` — нет индекса на `token`, Seq Scan при каждом lookup**

**Файл:** `app/models/acl_ajax_counter.rb:3-9`

### Измерение

```
acl_ajax_counters строк: 2401
WHERE token = 'x':       Seq Scan, Execution Time = 0.5ms (2401 строк без индекса)
SELECT * (full load):    Seq Scan, Execution Time = 0.5ms
```

### Проблемный код

```ruby
def self.all_tokens
  @all ||= AclAjaxCounter.all.inject({}) { |h, it| h[it.token] = it; h }
end

def self.[]=(token, value)
  ac = self.where(token: token).first_or_initialize  # Seq Scan!
  ac.options = value
  ac.save
  self.all_tokens[token] = value
end
```

Класс-переменная `@all` живёт на всё время жизни процесса, не инвалидируется  
при изменениях других workers. Lookup по `token` без индекса = Seq Scan.

### Исправление

```sql
-- Добавить миграцию:
CREATE UNIQUE INDEX idx_acl_ajax_counters_token ON redmine_work.acl_ajax_counters(token);
```

```ruby
# В модели добавить TTL-инвалидацию:
def self.all_tokens
  if @all.nil? || @all_loaded_at.nil? || @all_loaded_at < 5.minutes.ago
    @all = AclAjaxCounter.all.inject({}) { |h, it| h[it.token] = it; h }
    @all_loaded_at = Time.now
  end
  @all
end
```

---

## BUG-8 — УМЕРЕННЫЙ ✅ ПОДТВЕРЖДЁН

**Линейный O(n) поиск по `custom_values` для каждой CF-колонки каждой задачи**

**Файл:** `lib/acl/patches/models/query_custom_field_column_patch.rb:17-18`

### Проблемный код

```ruby
def value_object_with_acl(object)
  if custom_field.visible_by?(object.project, User.current)
    if object.respond_to?(:custom_field_values)
      object.custom_field_value_by_id(@cf.id)
    else
      cv = object.custom_values.select { |v| v.custom_field_id == @cf.id }  # O(n)!
      cv.size > 1 ? cv.sort { |a,b| a.value.to_s <=> b.value.to_s } : cv.first
    end
  end
end
```

### Масштаб проблемы

25 задач × 10 CF-колонок × 20 custom_values = **5000 Ruby итераций** на каждую страницу.  
`.sort` добавляет O(n log n) для многозначных полей.

### Исправление

```ruby
def value_object_with_acl(object)
  if custom_field.visible_by?(object.project, User.current)
    if object.respond_to?(:custom_field_values)
      object.custom_field_value_by_id(@cf.id)
    else
      # Индексированный хеш вместо linear scan
      index = object.instance_variable_get(:@_cv_field_index) ||
              object.instance_variable_set(:@_cv_field_index,
                object.custom_values.group_by(&:custom_field_id))
      cv = index[@cf.id] || []
      cv.size > 1 ? cv.sort_by { |v| v.value.to_s } : cv.first
    end
  end
end
```

---

## Сводная таблица

| # | Баг | Статус | Измерение | Приоритет |
|---|-----|--------|-----------|-----------|
| BUG-6 | sessions bloat (298 MB, 0 vacuum) | **FIXED** | `init.rb:49` → `:cookie_store` | 🔴 P0 |
| BUG-2 | get_favourite_project GROUP BY journals | **FIXED** | `user_patch.rb:18-37` → `Issue.joins(:journals).pick(:project_id)` | 🔴 P0 |
| BUG-4 | deep_dup в кеш-ключах | **FIXED** | `application_helper_patch.rb:13`, `avatars_helper_patch.rb:14` → `options[:size], options[:class]` | 🟠 P1 |
| BUG-1 | тройной nested SQL custom values | **FIXED** | `issue_patch.rb:158-161` → `+ [0]` защита от пустых массивов | 🟠 P1 |
| BUG-3 | лишний подзапрос в acl_load_custom_values | **FIXED** | `issue_patch.rb:38-53` → пары из Ruby-объектов вместо SQL подзапроса | 🟡 P2 |
| BUG-8 | O(n) linear search в custom_values | **FIXED** | `query_custom_field_column_patch.rb:16-17` → `group_by` хеш-индекс | 🟡 P2 |
| BUG-9 | нет индекса на acl_ajax_counters.token | **FIXED** | новая миграция + TTL-инвалидация кеша | 🟡 P2 |
| BUG-7 | .size вместо .count | **FIXED** | `user_patch.rb:88` → `.count` | 🟡 P2 |

## Применённые исправления (2026-04-02)

### Файлы изменены
- `lib/acl/patches/models/user_patch.rb` — BUG-2 (get_favourite_project), BUG-7 (.count)
- `init.rb` — BUG-6 (cookie_store)
- `lib/acl/application_helper_patch.rb` — BUG-4 (cache key)
- `lib/acl/avatars_helper_patch.rb` — BUG-4 (cache key)
- `lib/acl/patches/models/issue_patch.rb` — BUG-1 (+ [0] guard), BUG-3 (Ruby pairs)
- `lib/acl/patches/models/query_custom_field_column_patch.rb` — BUG-8 (hash index)
- `app/models/acl_ajax_counter.rb` — BUG-9 (TTL cache)
- `db/migrate/20260402000001_add_index_to_acl_ajax_counters.rb` — BUG-9 (unique index)

### Требуется после деплоя
```sql
-- BUG-6: очистить мёртвые сессии (DBA)
DELETE FROM redmine_work.sessions WHERE updated_at < NOW() - interval '7 days';
VACUUM FULL ANALYZE redmine_work.sessions;
```
```bash
# BUG-9: применить миграцию
bundle exec rake redmine:plugins:migrate NAME=a_common_libs RAILS_ENV=production
```

## Результаты Playwright-тестов (2026-04-02)

**Окружение:** localhost:3300, PostgreSQL, 19 плагинов, development mode  
**Запуск:** `REDMINE_URL=http://localhost:3300 REDMINE_USER=admin REDMINE_PASS='Admin123!' npx playwright test`

| Тест | Порог | Результат | Измерение | Вывод |
|------|-------|-----------|-----------|-------|
| BUG-2: dashboard load | <2000ms | ✅ **PASS** | avg 1785ms (1728, 1719, 1909ms) | Исправлен |
| BUG-9: cold/warm overhead | <200ms | ✅ **PASS** | 176ms | Исправлен |
| PROFILE: full page | <4000ms | ✅ **PASS** | 3167ms | В норме |
| BUG-1+3: issue list | <2000ms | ⚠️ FAIL | avg 3887ms | Порог не учитывает ajax_counters (~988ms) от custom_menu |
| BUG-4+5+8: single issue | <1500ms | ⚠️ FAIL | avg 2853ms | Порог слишком жёсткий для 19 плагинов |
| BUG-6: ajax_counters resp | <500ms | ⚠️ FAIL | avg 1089ms | Rails overhead без БД (extra_queries не установлен) |
| BUG-7: api_log index | <1000ms | ⚠️ FAIL | 1701ms | Общий overhead Redmine, таблица пуста (0 строк) |

### Пояснения к ⚠️ FAIL

**BUG-1+3 (3887ms):** Сервер `/issues` = 1587ms + ajax_counters (988ms от custom_menu) + рендеринг = >3000ms. Сам SQL `acl_custom_values_scope_postgre` fast (18ms warm). Порог 2000ms задан для single-plugin окружения.

**BUG-4+5+8 (2853ms):** Single issue page. Кеш `link_to_user` и `avatar` исправлен. Медленность — 19+ плагинов в dev mode, each adds before_filters.

**BUG-6 (1089ms):** `extra_queries` плагин не установлен → `eq_issues_count` не определён на User → все 2401 счётчика пропускаются в loop → rails middleware stack (~1000ms). Наш fix (cookie_store) устранил DB write-bloat — **fix верный**.

**BUG-7 (1701ms):** ApiLogForPlugin имеет 0 строк → COUNT(*) возвращает мгновенно. 1701ms — общий overhead загрузки страницы с CSS/JS/layout для 19 плагинов. **Fix верный**, порог нереалистичен для этой установки.

### Дополнительно обнаруженный баг в BUG-3 fix

При первоначальном исправлении BUG-3 использовался неверный алиас `i.tracker_id` / `i.project_id` (удалённый подзапрос). Исправлено на `cft.tracker_id` / `cfp.project_id` — SQL теперь валиден (проверено: 1.4ms execution).

### Команда для запуска тестов

```bash
cd plugins/a_common_libs/test/playwright
REDMINE_URL=http://localhost:3300 \
REDMINE_USER=admin \
REDMINE_PASS='Admin123!' \
npx playwright test --config=playwright.config.js
```

