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
  float pop = 0.50f; // de-plosive: tames "p"/"b" blasts
  float pitch = 0.0f; // semitones, -12..+12; 0 = untouched

  // Voice effects — the "ready voices" (robot, cave, walkie-talkie…). All neutral at zero.
  float fxPitch = 0;      // semitones, added to `pitch`
  float fxRingHz = 0;     // ring-modulator carrier in Hz; 0 = off
  float fxRingMix = 0;    // 0..1
  float fxEchoMs = 0;     // echo delay; 0 = off
  float fxEchoFb = 0;     // 0..0.85
  float fxEchoMix = 0;    // 0..1
  float fxPhone = 0;      // 1 = telephone band (420 Hz … 3.2 kHz)
  float fxDrive = 0;      // 0..1 distortion
  float fxTremHz = 0;     // tremolo rate; 0 = off
  float fxTremDepth = 0;  // 0..1
  float fxLowpassHz = 0;  // muffling low-pass; 0 = off
  float fxSpace = 0;      // extra room, added to `space`
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
  float lo = 0, envLo = 0, pg = 1;
  float envRel = 0, gAtt = 0, gRel = 0, holdN = 0, rmsA = 0, agA = 0, lpA = 0, hiRel = 0, loA = 0, loRel = 0;

  void prepare(float sr) {
    envRel = std::exp(-1.0f / (0.05f * sr));
    gAtt = onePole(0.002f, sr);
    gRel = onePole(0.12f, sr);
    holdN = 0.18f * sr;
    rmsA = onePole(0.4f, sr);
    agA = onePole(1.5f, sr);
    lpA = 1.0f - std::exp(-2.0f * kPi * std::min(5200.0f, 0.4f * sr) / sr);
    hiRel = std::exp(-1.0f / (0.03f * sr));
    loA = 1.0f - std::exp(-2.0f * kPi * 100.0f / sr);
    loRel = std::exp(-1.0f / (0.06f * sr));
  }

  inline float process(float x, float thr, float deess, bool autoLevel, float pop) {
    const float a = std::fabs(x);
    env = std::max(a, env * envRel);

    // Gate: open fast, hold through the gaps between words, close softly to a floor.
    if (env > thr) { open = true; hold = holdN; }
    else if (env < thr * 0.63f) { if (hold > 0) hold -= 1; else open = false; }
    const float tg = open ? 1.0f : 0.03f;
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

    // De-plosive: the band under ~100 Hz sits below most voices' pitch, so a burst there is
    // breath hitting the capsule, not speech. Duck just that band while it lasts.
    lo += (x - lo) * loA;
    envLo = std::max(std::fabs(lo), envLo * loRel);
    const float popThr = 0.04f;
    const float tp = (pop > 0 && envLo > popThr) ? std::pow(popThr / envLo, pop * 0.9f) : 1.0f;
    pg += (tp - pg) * (tp < pg ? 0.05f : 0.004f);
    x = (x - lo) + lo * pg;

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

// Pitch shifter: two taps sweep through a short delay line (which is what changes the pitch)
// and cross-fade into each other every time one of them has to jump back.
//
// The jump is where such shifters go wrong: if the tap lands at an arbitrary place, the two
// taps play the voice out of phase during the cross-fade and partly cancel — the familiar
// warble. So each time a tap jumps (it is silent at that instant), it is slid by up to a few
// milliseconds to the spot where the waveform best matches what the other tap is playing.
// Costs ~20-28 ms of latency while in use.
class PitchShifter {
 public:
  void prepare(float sr) {
    window_ = 0.040f * sr;
    search_ = int(0.008f * sr);
    span_ = int(0.014f * sr); // longer than one period of the lowest voices, or they cannot be matched
    size_ = 1;
    while (size_ < int(window_) + 2 * search_ + span_ + 16) size_ <<= 1;
    buf_.assign(size_t(size_), 0.0f);
    pos_ = 0;
    phase_ = 0;
    offset_[0] = offset_[1] = 0;
  }
  void setAligned(bool on) { aligned_ = on; } // off = the plain two-tap shifter, kept for comparison in tests

  inline float process(float x, float ratio) {
    buf_[size_t(pos_)] = x;
    const float before = phase_;
    phase_ += (1.0f - ratio) / window_; // the delay grows to lower the pitch, shrinks to raise it
    bool jumpA = false;
    if (phase_ >= 1.0f) { phase_ -= 1.0f; jumpA = true; }
    if (phase_ < 0.0f) { phase_ += 1.0f; jumpA = true; }
    const float other = phase_ >= 0.5f ? phase_ - 0.5f : phase_ + 0.5f;
    const float otherBefore = before >= 0.5f ? before - 0.5f : before + 0.5f;
    const bool jumpB = std::fabs(other - otherBefore) > 0.5f;
    if (aligned_) {
      if (jumpA) offset_[0] = align(phase_, other, offset_[1]);
      if (jumpB) offset_[1] = align(other, phase_, offset_[0]);
    }
    const float w = 0.5f - 0.5f * std::cos(2.0f * kPi * phase_); // silent exactly where the tap jumps
    const float out = tap(2.0f + phase_ * window_ + offset_[0]) * w + tap(2.0f + other * window_ + offset_[1]) * (1.0f - w);
    pos_ = (pos_ + 1) & (size_ - 1);
    return out;
  }

 private:
  // Where should the tap that just jumped land so that it is in phase with the other one?
  float align(float jumped, float playing, float playingOffset) const {
    const int ref = int(2.0f + playing * window_ + playingOffset);
    const int nominal = int(2.0f + jumped * window_);
    const bool nearZero = jumped < 0.5f; // at the short end of the delay it can only move further back
    const int from = nearZero ? 0 : -2 * search_, to = nearZero ? 2 * search_ : 0;
    float best = -1e30f;
    int bestOffset = 0;
    for (int o = from; o <= to; o += 2) {
      float dot = 0, energy = 1e-9f;
      for (int k = 0; k < span_; k += 2) {
        const float c = at(nominal + o + k);
        dot += c * at(ref + k);
        energy += c * c;
      }
      const float score = dot / std::sqrt(energy);
      if (score > best) {
        best = score;
        bestOffset = o;
      }
    }
    return float(bestOffset);
  }
  inline float at(int delay) const { return buf_[size_t((pos_ - delay) & (size_ - 1))]; }
  inline float tap(float delay) const {
    float where = float(pos_) - delay;
    if (where < 0) where += float(size_);
    const int i0 = int(where);
    const float frac = where - float(i0);
    return buf_[size_t(i0 & (size_ - 1))] * (1 - frac) + buf_[size_t((i0 + 1) & (size_ - 1))] * frac;
  }
  std::vector<float> buf_;
  int size_ = 1, pos_ = 0, search_ = 384, span_ = 384;
  float window_ = 1920, phase_ = 0;
  float offset_[2] = {0, 0};
  bool aligned_ = true;
};

// The effects stage, between the voice chain and the room/limiter. Everything is bypassed
// (one comparison per sample) until an effect is switched on.
class Effects {
 public:
  void prepare(float sr) {
    sr_ = sr;
    echo_.assign(size_t(0.65f * sr) + 8, 0.0f);
    pos_ = 0;
    ringPhase_ = tremPhase_ = 0;
    ringMix_ = echoMix_ = drive_ = tremDepth_ = 0;
    smooth_ = onePole(0.03f, sr);
  }
  void set(const Params& p) {
    ringStep_ = 2.0f * kPi * p.fxRingHz / sr_;
    ringTarget_ = p.fxRingHz > 0 ? p.fxRingMix : 0;
    const float wantEcho = p.fxEchoMs > 0 ? p.fxEchoMix : 0;
    if (wantEcho > 0 && echoTarget_ <= 0) std::fill(echo_.begin(), echo_.end(), 0.0f); // no stale tail from last time
    echoTarget_ = wantEcho;
    echoLen_ = std::clamp(int(p.fxEchoMs * 0.001f * sr_), 1, int(echo_.size()) - 1);
    echoFb_ = std::min(p.fxEchoFb, 0.85f);
    const bool phone = p.fxPhone > 0.5f;
    if (phone && !phone_) { hp_ = Biquad(); lp_ = Biquad(); }
    phone_ = phone;
    if (phone_) { hp_.highpass(sr_, 420, 0.8f); lp_.lowpass(sr_, 3200, 0.8f); }
    const bool muffle = p.fxLowpassHz > 0;
    if (muffle && !muffle_) low_ = Biquad();
    muffle_ = muffle;
    if (muffle_) low_.lowpass(sr_, p.fxLowpassHz, 0.9f);
    driveTarget_ = p.fxDrive;
    tremStep_ = 2.0f * kPi * p.fxTremHz / sr_;
    tremTarget_ = p.fxTremHz > 0 ? p.fxTremDepth : 0;
    wanted_ = ringTarget_ > 0 || echoTarget_ > 0 || phone_ || muffle_ || driveTarget_ > 0 || tremTarget_ > 0;
  }
  inline float process(float x) {
    if (!wanted_ && ringMix_ < 1e-4f && echoMix_ < 1e-4f && drive_ < 1e-4f && tremDepth_ < 1e-4f) return x;
    ringMix_ += (ringTarget_ - ringMix_) * smooth_;
    echoMix_ += (echoTarget_ - echoMix_) * smooth_;
    drive_ += (driveTarget_ - drive_) * smooth_;
    tremDepth_ += (tremTarget_ - tremDepth_) * smooth_;

    if (drive_ > 0.001f) x = std::tanh(x * (1.0f + drive_ * 24.0f)) / (1.0f + drive_ * 6.0f); // megaphone grit, level kept sane
    if (phone_) x = lp_.process(hp_.process(x)) * 1.6f;
    if (muffle_) x = low_.process(x);
    if (ringMix_ > 0.001f) { // multiply by a tone: the classic robot
      if ((ringPhase_ += ringStep_) > 2 * kPi) ringPhase_ -= 2 * kPi;
      x = x * (1.0f - ringMix_) + x * std::sin(ringPhase_) * ringMix_ * 1.4f;
    }
    if (tremDepth_ > 0.001f) {
      if ((tremPhase_ += tremStep_) > 2 * kPi) tremPhase_ -= 2 * kPi;
      x *= 1.0f - tremDepth_ * (0.5f + 0.5f * std::sin(tremPhase_));
    }
    const int size = int(echo_.size());
    const float delayed = echo_[size_t((pos_ + size - echoLen_) % size)];
    echo_[size_t(pos_)] = x + delayed * echoFb_;
    if (++pos_ >= size) pos_ = 0;
    return x + delayed * echoMix_;
  }

 private:
  float sr_ = 48000, smooth_ = 0;
  std::vector<float> echo_;
  int pos_ = 0, echoLen_ = 1;
  float echoFb_ = 0, echoMix_ = 0, echoTarget_ = 0;
  float ringStep_ = 0, ringPhase_ = 0, ringMix_ = 0, ringTarget_ = 0;
  float tremStep_ = 0, tremPhase_ = 0, tremDepth_ = 0, tremTarget_ = 0;
  float drive_ = 0, driveTarget_ = 0;
  bool phone_ = false, muffle_ = false, wanted_ = false;
  Biquad hp_, lp_, low_;
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
    pitch_.prepare(sr_);
    fx_.prepare(sr_);
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
    revT_ = std::min(p.space + p.fxSpace, 1.6f) * 4.5f;
    gateThr_ = p.clean > 0.01f ? dbToGain(-65.0f + p.clean * 40.0f) : 1e-5f;
    inT_ = dbToGain(p.inGainDb);
    const float semitones = std::clamp(p.pitch + p.fxPitch, -14.0f, 14.0f);
    pitchRatio_ = std::fabs(semitones) < 0.01f ? 1.0f : std::pow(2.0f, semitones / 12.0f);
    fx_.set(p);
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

      float x = in[n] * inG_;
      if (pitchRatio_ != 1.0f) x = pitch_.process(x, pitchRatio_);
      x = hpf_.process(x);
      x = dyn_.process(x, gateThr_, deess, autoLevel, params_.pop);
      x = air_.process(pres_.process(low_.process(mud_.process(x))));

      // Soft-knee feed-forward compressor, no look-ahead (adds no latency).
      const float over = 20.0f * std::log10(std::fabs(x) + 1e-9f) - thrDb_;
      float target = 0;
      if (2 * over > knee) target = slope * over;
      else if (2 * over > -knee) target = slope * (over + knee / 2) * (over + knee / 2) / (2 * knee);
      compDb_ += (target - compDb_) * (target < compDb_ ? compAtt_ : compRel_);
      x *= dbToGain(compDb_) * makeup_;

      // Exciter: harmonics from the top of the voice, blended back in.
      const float t = fx_.process(x + exOut_.process(std::tanh(exIn_.process(x) * 6.0f)) * exG_);

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
  PitchShifter pitch_;
  float pitchRatio_ = 1.0f;
  Effects fx_;
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
