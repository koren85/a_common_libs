# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`a_common_libs` is a Redmine plugin (v2.5.7) that provides shared libraries, helpers, and monkey-patches for the RMPlus plugin ecosystem. It targets **Redmine 4.0+** on **Rails 5**. It bundles JS/CSS libraries (Select2, Bootstrap modals, FontAwesome, jqPlot, periodpicker), extends Redmine's custom field system, adds AJAX counters, API logging, and various performance patches.

## Development Commands

This is a Redmine plugin — there is no standalone build/test. All commands run from the Redmine root (`../../` relative to this plugin):

```bash
# Run Redmine migrations including plugin migrations
bundle exec rake redmine:plugins:migrate RAILS_ENV=development

# Start Redmine server (plugin loads automatically)
bundle exec rails server

# Run Redmine's full test suite
bundle exec rake test

# Run plugin-specific migration only
bundle exec rake redmine:plugins:migrate NAME=a_common_libs
```

## Architecture

### Plugin Entry Point

[init.rb](init.rb) — Registers the plugin with Redmine, defines custom menus, sets up wiki macros, patches I18n, and triggers the loader chain via `Rails.application.config.to_prepare`.

### Patch Loading System

The plugin uses a convention-based auto-patching system:

1. [init.rb](init.rb) schedules `load 'acl/loader.rb'` in `to_prepare` (reloaded on each request in dev)
2. [lib/acl/loader.rb](lib/acl/loader.rb) requires all dependencies then calls `Acl::Patches.load_all_dependencies`
3. [lib/acl/patches.rb](lib/acl/patches.rb) scans `lib/acl/patches/**/*.rb`, derives the target class from the filename (e.g., `issue_patch.rb` → `Issue`), and includes the patch module if not already included
4. Patches can override the auto-detection by defining `self.target_object` on the patch module

**Patch file convention:** `lib/acl/patches/{controllers,models,helpers}/<target_name>_patch.rb` — the `_patch` suffix is stripped to resolve the target class.

### Key Patch Categories

- **Models:** Issue, User, Project, CustomField, Query, TimeEntry, Mailer, UserPreference
- **Controllers:** ApplicationController, IssuesController, CustomFieldsController, SettingsController
- **Helpers:** ApplicationHelper, CustomFieldsHelper, QueriesHelper

### Legacy Compatibility

[lib/acl/alias_patch.rb](lib/acl/alias_patch.rb) re-adds `alias_method_chain` (removed in Rails 5) to `Module` globally. This is required because other RMPlus plugins still use this pattern.

### Routes

[config/routes.rb](config/routes.rb) defines: AJAX counters endpoint, icon upload, custom field AJAX values/options, API log viewer, and issue edit form/trimmed CF display.

### Custom Field Extensions

The plugin extends Redmine's custom field system with:
- A `Percent` field format ([lib/acl/redmine/field_format.rb](lib/acl/redmine/field_format.rb))
- Association-based CF columns ([lib/acl/redmine/query_custom_field_association_column.rb](lib/acl/redmine/query_custom_field_association_column.rb))
- AJAX-enabled custom field editing
- Trimmed display for multi-value CFs

### Frontend Assets

`assets/` contains vendored JS libraries (not managed by npm/yarn). Key files:
- `assets/javascripts/a_common_libs.js` — main plugin JS
- `assets/javascripts/modal_windows.js` — Bootstrap-based modal system
- `assets/javascripts/ajax_counters.js` — polling AJAX counter system
- `assets/stylesheets/` — plugin styles, Select2 theme, FontAwesome

### Database

Migrations add: favourite project preference, ajaxable flag on custom fields, API log table, session store table, AJAX counter settings, trimmed CF values, and indexes on custom_values.
