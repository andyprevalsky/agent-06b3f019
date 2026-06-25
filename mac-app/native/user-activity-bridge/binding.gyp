{
  "targets": [
    {
      "target_name": "rose_user_activity_bridge",
      "sources": ["user_activity_bridge.mm"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "OTHER_LDFLAGS": ["-framework", "Cocoa"]
      }
    }
  ]
}
