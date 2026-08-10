{
  "targets": [
    {
      "target_name": "gameinput_bridge",
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/gameinput_bridge.cc"],
          "include_dirs": ["vendor/gameinput/include"],
          "libraries": ["../vendor/gameinput/lib/x64/GameInput.lib"],
          "defines": ["_HAS_EXCEPTIONS=0"]
        }, {
          "type": "none"
        }]
      ]
    }
  ]
}
