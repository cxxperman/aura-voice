// Aura voice chain — the C++ twin of app/engine.js.
//
// mono in → input gain → high-pass → dynamics (gate, auto-level, de-esser)
//         → EQ (mud cut, warmth, presence, air) → compressor → exciter
//         → stereo doubler + room reverb → limiter → stereo out
//
// Header-only, no dependencies. prepare() allocates; process() never does,
// so it is safe to call from the audio engine's real-time thread.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace aura {

constexpr float kPi = 3.14159265358979f;

// Sliders are 0..1, gains are in dB.
struct Params {
  float warmth = 0.55f;
  float clarity = 0.50f;
  float air = 0.45f;
  float density = 0.55f;
  float width = 0.35f;
  float space = 0.12f;
  float clean = 0.45f;
  float deess = 0.50f;
  float autoLevel = 1.0f;
  float inGainDb = 0.0f;
  float outGainDb = 0.0f;
};

inline float dbToGain(float db) { return std::pow(10.0f, db / 20.0f); }
inline float onePole(float seconds, float sr) { return 1.0f - std::exp(-1.0f / (seconds * sr)); }

// RBJ cookbook biquad, transposed direct form II.
struct Biquad {
  float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;

  inline float process(float x) {
    const float y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  }
  void reset() { z1 = z2 = 0; }

  void set(float B0, float B1, float B2, float A0, float A1, float A2) {
    b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0;
  }
  // Capture can run at 16 kHz; keep every corner safely below Nyquist.
  static float omega(float sr, float f) { return 2.0f * kPi * std::min(f, 0.45f * sr) / sr; }

  void highpass(float sr, float f, float q) {
    const float w = omega(sr, f), cs = std::cos(w), al = std::sin(w) / (2 * q);
    set((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al);
  }
  void lowpass(float sr, float f, float q) {
    const float w = omega(sr, f), cs = std::cos(w), al = std::sin(w) / (2 * q);
    set((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al);
  }
  void peaking(float sr, float f, float q, float gainDb) {
    const float A = std::pow(10.0f, gainDb / 40.0f);
    const float w = omega(sr, f), cs = std::cos(w), al = std::sin(w) / (2 * q);
    set(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
  }
  void lowshelf(float sr, float f, float gainDb) {
    const float A = std::pow(10.0f, gainDb / 40.0f);
    const float w = omega(sr, f), cs = std::cos(w);
    const float k = 2 * std::sqrt(A) * (std::sin(w) / 2 * std::sqrt(2.0f));
    set(A * ((A + 1) - (A - 1) * cs + k), 2 * A * ((A - 1) - (A + 1) * cs), A * ((A + 1) - (A - 1) * cs - k),
        (A + 1) + (A - 1) * cs + k, -2 * ((A - 1) + (A + 1) * cs), (A + 1) + (A - 1) * cs - k);
  }
  void highshelf(float sr, float f, float gainDb) {
    const float A = std::pow(10.0f, gainDb / 40.0f);
    const float w = omega(sr, f), cs = std::cos(w);
    const float k = 2 * std::sqrt(A) * (std::sin(w) / 2 * std::sqrt(2.0f));
    set(A * ((A + 1) + (A - 1) * cs + k), -2 * A * ((A - 1) + (A + 1) * cs), A * ((A + 1) + (A - 1) * cs - k),
        (A + 1) - (A - 1) * cs + k, 2 * ((A - 1) - (A + 1) * cs), (A + 1) - (A - 1) * cs - k);
  }
};

// Gate + auto-level + de-esser, sample by sample.
struct Dynamics {
  float env = 0, g = 1, hold = 0;
  bool open = false;
  float rms = 0.01f, ag = 1;
  float lp = 0, envHi = 0, dg = 1;
  float envRel = 0, gAtt = 0, gRel = 0, holdN = 0, rmsA = 0, agA = 0, lpA = 0, hiRel = 0;

  void prepare(float sr) {
    envRel = std::exp(-1.0f / (0.05f * sr));
    gAtt = onePole(0.002f, sr);
    gRel = onePole(0.12f, sr);
    holdN = 0.18f * sr;
    rmsA = onePole(0.4f, sr);
    agA = onePole(1.5f, sr);
    lpA = 1.0f - std::exp(-2.0f * kPi * std::min(5200.0f, 0.4f * sr) / sr);
    hiRel = std::exp(-1.0f / (0.03f * sr));
  }

  inline float process(float x, float thr, float deess, bool autoLevel) {
    const float a = std::fabs(x);
    env = std::max(a, env * envRel);

    // Gate: open fast, hold through the gaps between words, close softly to a floor.
    if (env > thr) { open = true; hold = holdN; }
    else if (env < thr * 0.63f) { if (hold > 0) hold -= 1; else open = false; }
    const float tg = open ? 1.0f : 0.06f;
    g += (tg - g) * (tg > g ? gAtt : gRel);

    // Auto-level: ride slowly towards -20 dBFS RMS, only while there is speech.
    if (autoLevel) {
      if (env > std::max(thr, 0.01f)) {
        rms += (x * x - rms) * rmsA;
        const float want = std::clamp(0.1f / (std::sqrt(rms) + 1e-6f), 0.5f, 6.0f);
        ag += (want - ag) * agA;
      }
    } else {
      ag += (1.0f - ag) * agA;
    }
    x *= g * ag;

    // De-esser: split at ~5 kHz, duck only the top band when sibilance spikes.
    lp += (x - lp) * lpA;
    const float hi = x - lp;
    envHi = std::max(std::fabs(hi), envHi * hiRel);
    const float deThr = 0.02f;
    const float td = (deess > 0 && envHi > deThr) ? std::pow(deThr / envHi, deess * 0.75f) : 1.0f;
    dg += (td - dg) * 0.02f;
    return lp + hi * dg;
  }
};

// Freeverb-style room: 8 damped combs + 4 all-passes per side.
class Room {
 public:
  void prepare(float sr) {
    static const int comb[8] = {1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617};
    static const int allp[4] = {556, 441, 341, 225};
    const float k = sr / 44100.0f;
    for (int side = 0; side < 2; side++) {
      for (int i = 0; i < 8; i++) combs_[side][i].resize(int((comb[i] + side * 23) * k) + 1);
      for (int i = 0; i < 4; i++) alls_[side][i].resize(int((allp[i] + side * 23) * k) + 1);
    }
  }
  inline void process(float in, float& l, float& r) {
    const float x = in * 0.015f;
    float out[2];
    for (int side = 0; side < 2; side++) {
      float acc = 0;
      for (auto& c : combs_[side]) acc += c.comb(x, 0.78f, 0.3f);
      for (auto& a : alls_[side]) acc = a.allpass(acc);
      out[side] = acc;
    }
    l = out[0];
    r = out[1];
  }

 private:
  struct Line {
    std::vector<float> buf;
    size_t idx = 0;
    float store = 0;
    void resize(int n) { buf.assign(size_t(n), 0.0f); idx = 0; store = 0; }
    inline float comb(float in, float feedback, float damp) {
      const float out = buf[idx];
      store = out * (1 - damp) + store * damp;
      buf[idx] = in + store * feedback;
      if (++idx >= buf.size()) idx = 0;
      return out;
    }
    inline float allpass(float in) {
      const float delayed = buf[idx];
      buf[idx] = in + delayed * 0.5f;
      if (++idx >= buf.size()) idx = 0;
      return delayed - in;
    }
  };
  Line combs_[2][8];
  Line alls_[2][4];
};

class Chain {
 public:
  void prepare(float sampleRate) {
    sr_ = sampleRate;
    hpf_.highpass(sr_, 85, 0.707f);
    exIn_.highpass(sr_, 3000, 0.707f);
    exOut_.highpass(sr_, 3000, 0.707f);
    revHp_.highpass(sr_, 280, 0.707f);
    revLp_.lowpass(sr_, 6500, 0.707f);
    dyn_ = Dynamics();
    dyn_.prepare(sr_);
    room_.prepare(sr_);
    delay_.assign(size_t(0.05f * sr_) + 8, 0.0f);
    delayPos_ = 0;
    smooth_ = onePole(0.03f, sr_);
    compAtt_ = onePole(0.004f, sr_);
    compRel_ = onePole(0.18f, sr_);
    limRel_ = onePole(0.06f, sr_);
    compDb_ = 0;
    limG_ = 1;
    phase1_ = phase2_ = 0;
    hasParams_ = false;
    setParams(Params());
    // Start from the targets instead of fading in from zero.
    inG_ = inT_; outG_ = outT_; makeup_ = makeupT_; exG_ = exT_; widthG_ = widthT_; revG_ = revT_;
  }

  // Cheap when nothing changed; call once per block on the audio thread.
  void setParams(const Params& p) {
    if (hasParams_ && std::memcmp(&p, &params_, sizeof(Params)) == 0) return;
    params_ = p;
    hasParams_ = true;
    low_.lowshelf(sr_, 150, p.warmth * 7.5f - 1.0f);
    mud_.peaking(sr_, 300, 1.1f, -p.warmth * 3.5f);
    pres_.peaking(sr_, 3600, 0.9f, p.clarity * 6.0f);
    air_.highshelf(sr_, 10500, p.air * 9.0f);
    exT_ = p.clarity * 0.22f + p.air * 0.12f;
    thrDb_ = -12.0f - 26.0f * p.density;
    ratio_ = 2.0f + 5.0f * p.density;
    // Give back part of what the compressor takes, so "density" thickens rather than just gets louder.
    makeupT_ = dbToGain(0.3f * -thrDb_ * (1.0f - 1.0f / ratio_));
    widthT_ = p.width * 0.55f;
    revT_ = p.space * 4.5f;
    gateThr_ = p.clean > 0.01f ? dbToGain(-65.0f + p.clean * 40.0f) : 1e-5f;
    inT_ = dbToGain(p.inGainDb);
    outT_ = dbToGain(p.outGainDb);
  }

  float gainReductionDb() const { return compDb_; }

  // `in` may alias `outL` (in-place).
  void process(const float* in, float* outL, float* outR, int frames) {
    const float deess = params_.deess;
    const bool autoLevel = params_.autoLevel > 0.5f;
    const float lfo1 = 2.0f * kPi * 0.31f / sr_, lfo2 = 2.0f * kPi * 0.43f / sr_;
    const float knee = 10.0f, slope = 1.0f / ratio_ - 1.0f;
    const float ceiling = 0.79f; // -2 dBFS
    const int size = int(delay_.size());

    for (int n = 0; n < frames; n++) {
      inG_ += (inT_ - inG_) * smooth_;
      outG_ += (outT_ - outG_) * smooth_;
      makeup_ += (makeupT_ - makeup_) * smooth_;
      exG_ += (exT_ - exG_) * smooth_;
      widthG_ += (widthT_ - widthG_) * smooth_;
      revG_ += (revT_ - revG_) * smooth_;

      float x = hpf_.process(in[n] * inG_);
      x = dyn_.process(x, gateThr_, deess, autoLevel);
      x = air_.process(pres_.process(low_.process(mud_.process(x))));

      // Soft-knee feed-forward compressor, no look-ahead (adds no latency).
      const float over = 20.0f * std::log10(std::fabs(x) + 1e-9f) - thrDb_;
      float target = 0;
      if (2 * over > knee) target = slope * over;
      else if (2 * over > -knee) target = slope * (over + knee / 2) * (over + knee / 2) / (2 * knee);
      compDb_ += (target - compDb_) * (target < compDb_ ? compAtt_ : compRel_);
      x *= dbToGain(compDb_) * makeup_;

      // Exciter: harmonics from the top of the voice, blended back in.
      const float t = x + exOut_.process(std::tanh(exIn_.process(x) * 6.0f)) * exG_;

      // Doubler: two slowly drifting taps panned apart.
      delay_[size_t(delayPos_)] = t;
      const float tap1 = tap((0.013f + 0.0012f * std::sin(phase1_)) * sr_, size);
      const float tap2 = tap((0.021f + 0.0016f * std::sin(phase2_)) * sr_, size);
      if (++delayPos_ >= size) delayPos_ = 0;
      if ((phase1_ += lfo1) > 2 * kPi) phase1_ -= 2 * kPi;
      if ((phase2_ += lfo2) > 2 * kPi) phase2_ -= 2 * kPi;

      float rl, rr;
      room_.process(revLp_.process(revHp_.process(t)), rl, rr);

      float l = t + widthG_ * (tap1 * 0.997f + tap2 * 0.078f) + rl * revG_;
      float r = t + widthG_ * (tap1 * 0.078f + tap2 * 0.997f) + rr * revG_;

      // Stereo-linked limiter: instant attack, 60 ms release.
      const float peak = std::max(std::fabs(l), std::fabs(r));
      const float want = peak > ceiling ? ceiling / peak : 1.0f;
      limG_ = want < limG_ ? want : limG_ + (want - limG_) * limRel_;
      outL[n] = std::clamp(l * limG_ * outG_, -1.0f, 1.0f);
      outR[n] = std::clamp(r * limG_ * outG_, -1.0f, 1.0f);
    }
  }

 private:
  inline float tap(float delaySamples, int size) const {
    float pos = float(delayPos_) - delaySamples;
    if (pos < 0) pos += float(size);
    const int i0 = int(pos);
    const int i1 = i0 + 1 >= size ? 0 : i0 + 1;
    const float frac = pos - float(i0);
    return delay_[size_t(i0)] * (1 - frac) + delay_[size_t(i1)] * frac;
  }

  float sr_ = 48000;
  Params params_;
  bool hasParams_ = false;
  Biquad hpf_, mud_, low_, pres_, air_, exIn_, exOut_, revHp_, revLp_;
  Dynamics dyn_;
  Room room_;
  std::vector<float> delay_;
  int delayPos_ = 0;
  float phase1_ = 0, phase2_ = 0;
  float smooth_ = 0, compAtt_ = 0, compRel_ = 0, limRel_ = 0;
  float thrDb_ = -26, ratio_ = 4, gateThr_ = 1e-5f;
  float compDb_ = 0, limG_ = 1;
  float inG_ = 1, inT_ = 1, outG_ = 1, outT_ = 1, makeup_ = 1, makeupT_ = 1;
  float exG_ = 0, exT_ = 0, widthG_ = 0, widthT_ = 0, revG_ = 0, revT_ = 0;
};

} // namespace aura
