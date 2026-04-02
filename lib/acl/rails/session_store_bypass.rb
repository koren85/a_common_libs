# Only active when activerecord-session_store gem is available (active_record_store)
if defined?(ActiveRecord::SessionStore)
  module Acl::Rails
    class SessionStoreBypass < ActiveRecord::SessionStore::Session
      # to prevent saving session for API requests
      before_save do
        throw(:abort) if User.current.api_request?
      end
    end
  end

  if defined?(ActionDispatch::Session::ActiveRecordStore) &&
     ActionDispatch::Session::ActiveRecordStore.session_class == ActiveRecord::SessionStore::Session
    ActionDispatch::Session::ActiveRecordStore.session_class = Acl::Rails::SessionStoreBypass
  end
end

