// N-API bridge to Microsoft's GameInput API, built only for Windows x64.
//
// Exposes one JS function, poll(), which synchronously reads the first
// connected gamepad's state and returns a plain object. GameInput is
// initialized lazily on first poll() and set to
// GameInputEnableBackgroundInput, so readings keep coming while Last Epoch
// (not the overlay) holds Windows focus -- see
// docs/research/xbox-controller-overlay-feasibility.md. A failed
// GameInputCreate (missing redistributable, etc.) surfaces as
// { connected: false } instead of throwing, so the overlay stays usable
// without the bridge.
//
// NOTE: written against the documented v0 GameInput surface
// (learn.microsoft.com/en-us/gaming/gdk/docs/reference/input/gameinput-v0).
// This has never been compiled here -- GameInput headers/libs and MSVC only
// exist on Windows. Verify struct/enum names against the real gameinput.h
// from the Microsoft.GameInput NuGet package the first time this builds; see
// ../README.md for the exact build steps.

#include <node_api.h>
#include <windows.h>
#include <GameInput.h>

namespace {

IGameInput* g_gameInput = nullptr;
bool g_initFailed = false;

bool EnsureGameInput() {
  if (g_gameInput != nullptr) return true;
  if (g_initFailed) return false;

  if (FAILED(GameInputCreate(&g_gameInput))) {
    g_initFailed = true;
    return false;
  }

  // Keep receiving readings while Last Epoch, not this window, has focus.
  g_gameInput->SetFocusPolicy(GameInputEnableBackgroundInput);
  return true;
}

void SetBool(napi_env env, napi_value obj, const char* key, bool value) {
  napi_value v;
  napi_get_boolean(env, value, &v);
  napi_set_named_property(env, obj, key, v);
}

void SetDouble(napi_env env, napi_value obj, const char* key, double value) {
  napi_value v;
  napi_create_double(env, value, &v);
  napi_set_named_property(env, obj, key, v);
}

napi_value Disconnected(napi_env env) {
  napi_value obj;
  napi_create_object(env, &obj);
  SetBool(env, obj, "connected", false);
  SetBool(env, obj, "dpadUp", false);
  SetBool(env, obj, "dpadDown", false);
  SetBool(env, obj, "dpadLeft", false);
  SetBool(env, obj, "dpadRight", false);
  SetBool(env, obj, "aPressed", false);
  SetDouble(env, obj, "leftStickX", 0);
  SetDouble(env, obj, "leftStickY", 0);
  return obj;
}

napi_value Poll(napi_env env, napi_callback_info /*info*/) {
  if (!EnsureGameInput()) return Disconnected(env);

  IGameInputReading* reading = nullptr;
  HRESULT hr = g_gameInput->GetCurrentReading(GameInputKindGamepad, nullptr, &reading);
  if (FAILED(hr) || reading == nullptr) return Disconnected(env);

  GameInputGamepadState state;
  bool ok = reading->GetGamepadState(&state);
  reading->Release();
  if (!ok) return Disconnected(env);

  napi_value obj;
  napi_create_object(env, &obj);
  SetBool(env, obj, "connected", true);
  SetBool(env, obj, "dpadUp", (state.buttons & GameInputGamepadDPadUp) != 0);
  SetBool(env, obj, "dpadDown", (state.buttons & GameInputGamepadDPadDown) != 0);
  SetBool(env, obj, "dpadLeft", (state.buttons & GameInputGamepadDPadLeft) != 0);
  SetBool(env, obj, "dpadRight", (state.buttons & GameInputGamepadDPadRight) != 0);
  SetBool(env, obj, "aPressed", (state.buttons & GameInputGamepadA) != 0);
  SetDouble(env, obj, "leftStickX", state.leftThumbstickX);
  SetDouble(env, obj, "leftStickY", state.leftThumbstickY);
  return obj;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "poll", NAPI_AUTO_LENGTH, Poll, nullptr, &fn);
  napi_set_named_property(env, exports, "poll", fn);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
