// Neural noise suppression (RNNoise, Xiph.Org, BSD-3-Clause).
//
// RNNoise works on 10 ms frames of 48 kHz mono and is itself 10 ms late (its analysis windows
// overlap by half). The Windows audio engine normally hands us exactly such 10 ms buffers, and
// then every buffer is processed on the spot — no extra delay. Only when a buffer has an odd
// size does this wrapper fall back to collecting frames, which costs one more frame (10 ms).
//
// On top of the model's own cleaning it can close a "voice gate": RNNoise also reports how
// likely each frame is to contain speech, and everything that is confidently not speech
// (keyboard, clicks, breathing between words) is turned down further.
#pragma once

extern "C" {
#include "rnnoise.h"
}

namespace aura {

class Denoiser {
 public:
  static constexpr int kFrame = 480;

  Denoiser() = default;
  Denoiser(const Denoiser&) = delete;
  Denoiser& operator=(const Denoiser&) = delete;
  ~Denoiser() { release(); }

  // Not real-time safe: allocates, and warms the library up so process() never has to.
  bool prepare(float sampleRate) {
    release();
    if (sampleRate != 48000.0f) return false; // the model only knows 48 kHz
    state_ = rnnoise_create(nullptr);
    if (!state_) return false;
    float silence[kFrame] = {}, scratch[kFrame];
    rnnoise_process_frame(state_, scratch, silence); // first call builds the FFT tables
    for (int i = 0; i < kFrame; i++) in_[i] = out_[i] = 0;
    fill_ = 0;
    hold_ = 0;
    gate_ = 1;
    vad_ = 0;
    direct_ = false;
    return true;
  }

  bool ready() const { return state_ != nullptr; }
  float voiceProbability() const { return vad_; } // of the last frame, 0..1

  // In place.
  //   amount    0..1  how much of the cleaned signal replaces the original
  //   gateFloor 0..1  gain applied while no voice is detected; 1 = voice gate off
  void process(float* x, int frames, float amount, float gateFloor) {
    // Whole frames and nothing pending: run them straight through.
    if (fill_ == 0 && frames % kFrame == 0) {
      direct_ = true;
      for (int at = 0; at < frames; at += kFrame) {
        for (int k = 0; k < kFrame; k++) in_[k] = x[at + k];
        frame(amount, gateFloor);
        for (int k = 0; k < kFrame; k++) x[at + k] = out_[k];
      }
      return;
    }
    if (direct_) { // switching to buffered mode: do not replay the last direct frame
      direct_ = false;
      for (int k = 0; k < kFrame; k++) out_[k] = 0;
    }
    for (int i = 0; i < frames; i++) {
      in_[fill_] = x[i];
      x[i] = out_[fill_];
      if (++fill_ == kFrame) {
        fill_ = 0;
        frame(amount, gateFloor);
      }
    }
  }

 private:
  // in_ → out_
  void frame(float amount, float gateFloor) {
    float scaled[kFrame], clean[kFrame];
    for (int k = 0; k < kFrame; k++) scaled[k] = in_[k] * 32768.0f; // the model expects 16-bit scale
    vad_ = rnnoise_process_frame(state_, clean, scaled);

    // Voice gate: opens on the very frame speech is detected in and stays open 300 ms after it stops.
    if (vad_ >= 0.55f) hold_ = 30;
    else if (hold_ > 0) hold_--;
    const float target = hold_ > 0 ? 1.0f : gateFloor;
    for (int k = 0; k < kFrame; k++) {
      gate_ += (target - gate_) * (target > gate_ ? 0.02f : 0.0012f); // ~1 ms open, ~17 ms close
      out_[k] = (in_[k] + (clean[k] / 32768.0f - in_[k]) * amount) * gate_;
    }
  }

  void release() {
    if (state_) rnnoise_destroy(state_);
    state_ = nullptr;
  }

  DenoiseState* state_ = nullptr;
  float in_[kFrame] = {};
  float out_[kFrame] = {};
  int fill_ = 0;
  int hold_ = 0;
  float gate_ = 1;
  float vad_ = 0;
  bool direct_ = false;
};

// One "strength" knob, the way Krisp-style apps expose it:
//   0        off
//   0..0.62  blend in the model's cleaning, up to full
//   0.62..1  additionally close the voice gate, down to -26 dB between phrases
inline float denoiseAmount(float strength) { return strength >= 0.62f ? 1.0f : strength / 0.62f; }
inline float denoiseGateFloor(float strength) {
  return strength <= 0.62f ? 1.0f : 1.0f - (strength - 0.62f) / 0.38f * 0.95f;
}

} // namespace aura
