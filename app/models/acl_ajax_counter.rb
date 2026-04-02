class AclAjaxCounter < ActiveRecord::Base
  serialize :options
  def self.all_tokens
    if @all.nil? || @all_loaded_at.nil? || @all_loaded_at < 5.minutes.ago
      @all = AclAjaxCounter.all.inject({}) { |h, it| h[it.token] = it; h }
      @all_loaded_at = Time.now
    end
    @all
  end

  def self.[](token)
    self.all_tokens[token]
  end

  def self.[]=(token, value)
    ac = self.where(token: token).first_or_initialize
    ac.options = value
    ac.save
    self.all_tokens[token] = value
  end

  def [](name)
    (self.options || {})[name]
  end
end