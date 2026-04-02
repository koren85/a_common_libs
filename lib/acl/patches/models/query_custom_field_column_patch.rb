module Acl::Patches::Models
  module QueryCustomFieldColumnPatch
    def self.included(base)
      base.send :include, InstanceMethods

      base.class_eval do
        alias_method_chain :value_object, :acl
      end
    end

    module InstanceMethods
      def value_object_with_acl(object)
        if custom_field.visible_by?(object.project, User.current)
          if object.respond_to?(:custom_field_values)
            object.custom_field_value_by_id(@cf.id)
          else
            index = object.instance_variable_get(:@_cv_field_index) ||
                    object.instance_variable_set(:@_cv_field_index,
                      object.custom_values.group_by(&:custom_field_id))
            cv = index[@cf.id] || []
            cv.size > 1 ? cv.sort_by { |v| v.value.to_s } : cv.first
          end
        else
          nil
        end
      end
    end
  end
end