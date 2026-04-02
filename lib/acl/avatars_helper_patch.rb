module Acl
  module AvatarsHelperPatch
    def self.included(base)
      base.send :include, InstanceMethods

      base.class_eval do
        alias_method_chain :avatar, :acl
      end
    end

    module InstanceMethods

      def avatar_with_acl(user, options={})
        key = [user.class.name, user.try(:id), options[:size], options[:class]]
        @_avatar_acl_cache ||= {}
        @_avatar_acl_cache[key] ||= avatar_without_acl(user, options)
      end
    end
  end
end