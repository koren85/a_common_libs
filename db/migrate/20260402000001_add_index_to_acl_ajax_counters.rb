class AddIndexToAclAjaxCounters < ActiveRecord::Migration[5.2]
  def change
    add_index :acl_ajax_counters, :token, unique: true
  end
end
