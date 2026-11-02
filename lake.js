// WebGL2 lake: procedural atmosphere + analytic waves + interactive ripple sim over a refracted pebble bed.

const DEG = Math.PI / 180

// Scene views, mirroring the original's "alt" (looking down into the shallows) and "vast" (horizon) cameras.
export const VIEWS = {
  alt: { eye: 0.73, pitch: 18.3 * DEG, halfV: 18 * DEG, maxHalfH: 52 * DEG, depth: 1.05, clarity: 0.68, ripple: 1 },
  vast: { eye: 1.41, pitch: 6.3 * DEG, halfV: 24 * DEG, maxHalfH: 52 * DEG, depth: 1.9, clarity: 0.6, ripple: 1.3 },
}

const SIM_N = 512
const SIM_SIZE = 16 // metres; patch spans x∈[-8,8], z∈[0,16]
const SIM_HZ = 60
const SIM_SLEEP_S = 12
const MAX_RIPPLES = 8
const SKY_W = 1024
const SKY_H = 512

// ---------------------------------------------------------------- shaders

const VS = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2(gl_VertexID == 1 ? 3. : -1., gl_VertexID == 2 ? 3. : -1.);
  vUv = p * .5 + .5;
  gl_Position = vec4(p, 0., 1.);
}`

const COMMON = `#version 300 es
precision highp float;
precision highp sampler2D;
const float PI = 3.14159265;
float hash1(float n){ return fract(sin(n) * 43758.5453123); }
float hash2(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float hash3(vec3 p){ p = fract(p * .1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float noise1(float x){ float i = floor(x), f = fract(x); f = f*f*(3.-2.*f); return mix(hash1(i), hash1(i+1.), f); }
float noise2(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(hash2(i), hash2(i+vec2(1,0)), f.x), mix(hash2(i+vec2(0,1)), hash2(i+vec2(1,1)), f.x), f.y);
}
float fbm2(vec2 p){ float s = 0., a = .5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for(int i=0;i<6;i++){ s += a*noise2(p); p = m*p; a *= .5; } return s; }
// Sky LUT parameterisation: azimuth concentrated forward, elevation concentrated at the horizon.
vec2 skyUv(vec3 d){
  float az = atan(d.x, d.z);
  float el = asin(clamp(d.y, 0., 1.));
  return vec2(.5 + atan(3. * tan(clamp(az, -3.1415, 3.1415) * .5)) / PI, pow(el / (PI * .5), .7));
}
`

// Photographic sky + drifting cumulus + overcast, shared by the sky map and the per-pixel sky in view.
const SKY_CHUNK = `
uniform float uCloud, uCloudSeed, uOvercast, uPhotoOn, uMix, uRot;
uniform vec2 uWind;
uniform sampler2D uKeyA, uKeyB;
uniform vec4 uRange; // loA, hiA, loB, hiB (log2 radiance)
float hg(float mu, float g){ return (1.-g*g)/(4.*PI*pow(1.+g*g-2.*g*mu, 1.5)); }
// Cumulus deck at ~1.4 km, lit by the (reddened) sun and the zenith sky; drifts with the wind.
vec3 addClouds(vec3 d, vec3 sky, vec3 zen, float hi){
  float t = 1400. / max(d.y, .012);
  vec2 p = d.xz * t / 1900. + uWind + uCloudSeed;
  p += .35 * vec2(fbm2(p * .7 + 5.2), fbm2(p * .7 - 3.1)); // domain warp: billowy cumulus, not streaks
  float n = fbm2(p) + .22*fbm2(p*3.1 - uWind*1.7);
  n += hi * (.07 * noise2(p * 23.) + .035 * noise2(p * 53. + 3.)); // extra fine detail when drawn straight to the screen
  float cov = smoothstep(.6 - .2*uCloud, .78 - .1*uCloud, n);
  float sh = fbm2(p + uSun.xz / max(uSun.y, .06) * .09);
  float lit = mix(.4, 1., exp(-3.2 * smoothstep(.55, .9, sh)));
  float mu = dot(d, uSun);
  float body = smoothstep(.6, 1.05, n); // thicker cores are darker underneath
  // sunlit cumulus is several times brighter than the sky around it
  vec3 direct = uSunCol * (.5 + 2.6*hg(mu, .6)) * lit * smoothstep(-.06, .08, uSun.y);
  vec3 cloud = (direct * mix(1., .45, body) + zen * mix(1.7, .9, body)) + vec3(.0006, .0009, .0016);
  float air = exp(-t / 34000.);
  cloud = mix(sky, cloud, air);
  sky = mix(sky, cloud, cov * smoothstep(.0, .06, d.y));
  return sky;
}
vec3 photoSky(vec3 d){
  float az = atan(d.x, d.z) + uRot;
  vec2 uv = vec2(fract(az / (2.*PI)), asin(clamp(d.y, 0., 1.)) / (PI*.5));
  vec3 a = exp2(uRange.x + texture(uKeyA, uv).rgb * (uRange.y - uRange.x));
  vec3 b = exp2(uRange.z + texture(uKeyB, uv).rgb * (uRange.w - uRange.z));
  return mix(a, b, uMix);
}
vec3 skyFull(vec3 d, float hi){
  vec3 zen = photoSky(vec3(0., 1., 0.));
  vec3 sky = addClouds(d, photoSky(d), zen, hi);
  // overcast: a soft, even grey that is brighter overhead (CIE overcast falloff)
  float lz = dot(zen, vec3(.2126, .7152, .0722));
  vec3 grey = vec3(.9, .94, 1.) * lz * 1.55 * (1. + 2. * d.y) / 3.;
  return mix(sky, grey, uOvercast);
}
`

const SKY_FS = COMMON + `
in vec2 vUv; out vec4 o;
uniform vec3 uSun, uMoon, uSunCol;
uniform float uSunI, uMoonI;
${SKY_CHUNK}
const float Re = 6360e3, Ra = 6420e3;
const vec3 bR = vec3(5.802e-6, 13.558e-6, 33.1e-6);
const float bM = 3.996e-6;
const vec3 bO = vec3(.65e-6, 1.881e-6, .085e-6);
vec2 raySphere(vec3 ro, vec3 rd, float r){ float b = dot(ro, rd), c = dot(ro, ro) - r*r, h = b*b - c; if(h < 0.) return vec2(-1.); h = sqrt(h); return vec2(-b-h, -b+h); }
vec3 dens(float h){ return vec3(exp(-h/8e3), exp(-h/1.2e3), max(0., 1. - abs(h - 25e3)/15e3)); }
vec3 ext(vec3 od){ return bR*od.x + bM*1.11*od.y + bO*od.z; }
vec3 transTo(vec3 p, vec3 L){
  if(raySphere(p, L, Re).x > 0.) return vec3(0.);
  float t = raySphere(p, L, Ra).y, ds = t / 6.; vec3 od = vec3(0.);
  for(int i=0;i<6;i++){ vec3 q = p + L*(float(i)+.5)*ds; od += dens(length(q) - Re)*ds; }
  return exp(-ext(od));
}
vec3 scatter(vec3 d, vec3 L, float I){
  vec3 ro = vec3(0., Re + 2., 0.);
  float t = raySphere(ro, d, Ra).y;
  // Non-uniform steps: dense near the eye where the air is thick.
  vec3 odv = vec3(0.), sR = vec3(0.), sM = vec3(0.);
  float prev = 0.;
  for(int i=0;i<18;i++){
    float x = (float(i)+1.)/18., tt = t * x * x, ds = tt - prev;
    vec3 q = ro + d*(prev + ds*.5); prev = tt;
    vec3 de = dens(length(q) - Re) * ds;
    odv += de;
    vec3 T = exp(-ext(odv)) * transTo(q, L);
    sR += T*de.x; sM += T*de.y;
  }
  float mu = dot(d, L), g = .76;
  float pR = 3./(16.*PI)*(1.+mu*mu);
  float pM = 3./(8.*PI)*((1.-g*g)*(1.+mu*mu))/((2.+g*g)*pow(1.+g*g-2.*g*mu, 1.5));
  return I*(sR*bR*pR + sM*bM*pM);
}
vec3 dirFromUv(vec2 uv){
  float az = 2. * atan(tan((uv.x - .5) * PI) / 3.);
  float el = pow(uv.y, 1./.7) * PI * .5;
  return vec3(cos(el)*sin(az), sin(el), cos(el)*cos(az));
}
void main(){
  vec3 d = dirFromUv(vUv);
  d.y = max(d.y, .0015); d = normalize(d);
  if(uPhotoOn > .5){ o = vec4(skyFull(d, 0.), 1.); return; }
  vec3 sky = scatter(d, uSun, uSunI);
  vec3 zen = scatter(vec3(0,1,0), uSun, uSunI);
  if(uMoonI > 0.){ sky += scatter(d, uMoon, uMoonI); zen += scatter(vec3(0,1,0), uMoon, uMoonI); }
  sky += vec3(.0004, .0007, .0016); // airglow floor
  sky = addClouds(d, sky, zen, 0.);
  o = vec4(sky, 1.);
}`

const SIM_FS = COMMON + `
in vec2 vUv; out vec4 o;
uniform sampler2D uS;
uniform vec2 uTx;
uniform int uN;
uniform vec4 uSplat[16];  // uv.xy, radius(uv), unused
uniform vec2 uAmt[16];    // height, velocity
void main(){
  vec4 c = texture(uS, vUv);
  vec2 n = texture(uS, vUv + vec2(0, uTx.y)).rg, s = texture(uS, vUv - vec2(0, uTx.y)).rg;
  vec2 e = texture(uS, vUv + vec2(uTx.x, 0)).rg, w = texture(uS, vUv - vec2(uTx.x, 0)).rg;
  vec2 ne = texture(uS, vUv + uTx).rg, sw = texture(uS, vUv - uTx).rg;
  vec2 nw = texture(uS, vUv + vec2(-uTx.x, uTx.y)).rg, se = texture(uS, vUv + vec2(uTx.x, -uTx.y)).rg;
  vec2 lap = (4.*(n+s+e+w) + (ne+nw+se+sw) - 20.*c.rg) / 6.;
  float h = c.r, v = c.g;
  v += lap.x * .135 + lap.y * .028;
  v *= .9946; h += v; h *= .9995;
  float edge = min(min(vUv.x, 1.-vUv.x), min(vUv.y, 1.-vUv.y));
  float k = 1. - smoothstep(0., .055, edge);
  v *= mix(1., .86, k); h *= mix(1., .94, k);
  for(int i=0;i<16;i++){
    if(i >= uN) break;
    float d = length(vUv - uSplat[i].xy) / uSplat[i].z;
    float core = exp(-d*d), skirt = exp(-d*d*.18);
    h += uAmt[i].x * core;
    v += uAmt[i].y * (core - .235*skirt);
  }
  o = vec4(clamp(h, -.98, .98), clamp(v, -.98, .98), 0, 1);
}`

const WATER_FS = COMMON + `
in vec2 vUv; out vec4 o;
uniform vec2 uRes, uTan;
uniform vec3 uEye, uFwd, uUp, uRight;
uniform float uTime, uWaveAmp, uBreeze, uPixAng;
uniform vec4 uW[32]; // dir.xy, k, amplitude
uniform vec2 uW2[32]; // omega, phase
uniform sampler2D uSky, uBed, uBedN, uSim, uLand;
uniform float uLandOn;
uniform vec3 uLandGeo; // elTop, elBottom (radians), white level
uniform vec3 uLandLight;
uniform float uSimOn, uSimScale;
uniform vec4 uRip[${MAX_RIPPLES}]; // x, z, age(s), strength
uniform vec3 uSun, uSunCol, uMoon, uMoonCol;
uniform float uSunPow, uMoonPow, uNight, uSunset, uDay, uExposure, uSeed, uDepth, uClarity, uStars;
uniform vec4 uSeason;  // spring, summer, autumn, winter weights
uniform vec4 uWeather; // rain, snow, floating petals, floating leaves
uniform vec2 uDrift;   // slow surface current carrying the floaters
${SKY_CHUNK}

// --- distant mountains, as elevation (radians) over relative azimuth
float ridgeFar(float az, int oct){
  float e = 0., a = .5, f = 2.4;
  for(int i=0;i<6;i++){ if(i >= oct) break; e += a * (1. - abs(noise1(az*f + uSeed*7.1)*2. - 1.)); a *= .5; f *= 2.1; }
  return .02 + .2 * e*e * smoothstep(1.45, .15, abs(az - .12));
}
float ridgeNear(float az){
  float sides = pow(smoothstep(.05, 1.3, abs(az + .06)), 1.2);
  float hills = .022 + .3 * sides * (.66 + .34*noise1(az*2.6 + uSeed*3.)) + .018*noise1(az*6. + uSeed);
  return hills + .0028 * noise1(az*520.) * (.4 + sides); // tree tops
}
vec3 skyTex(vec3 d, float lod){ return textureLod(uSky, skyUv(d), lod).rgb; }
// returns rgb, coverage
vec4 mountains(vec3 d, float blur){
  float az = atan(d.x, d.z), el = asin(clamp(d.y, -1., 1.));
  float hn = ridgeNear(az), hf = ridgeFar(az, 6);
  float w = blur + uPixAng * .7;
  float cn = smoothstep(-w, w, hn - el), cf = smoothstep(-w, w, hf - el);
  float cov = max(cn, cf);
  if(cov <= 0.) return vec4(0.);
  vec3 hor = skyTex(normalize(vec3(d.x, .02, d.z)), 3.);
  vec3 amb = skyTex(vec3(0., 1., 0.), 6.) * .9;
  // slope toward the sun lights one side of each ridge
  float sAz = atan(uSun.x, uSun.z);
  // light each face by the broad (low-octave) ridge slope, so shading follows massifs, not noise
  float slope = (ridgeFar(az + .04, 3) - ridgeFar(az - .04, 3)) * 12.;
  float lamb = clamp(.5 - slope * sign(az - sAz) * 1.6, .08, 1.) * smoothstep(-.05, .1, uSun.y);
  float tex = .75 + .5 * noise2(vec2(az * 70., el * 420.));
  vec3 rock = vec3(.045, .047, .052) * tex;
  float snowLine = hf * .58 + .012 * (noise2(vec2(az * 22., 1.7)) - .5);
  float snow = smoothstep(-.003, .003, el - snowLine) * smoothstep(.05, .085, hf) * (.8 + .2*tex);
  vec3 far = mix(rock, vec3(.4, .42, .46), snow) * (amb + uSunCol * uSunPow * lamb * .9);
  far = mix(far, hor, .36);
  float trees = .6 + .8 * noise2(vec2(az * 240., el * 900.)) * noise2(vec2(az * 31., el * 90.));
  float gully = .7 + .6 * noise2(vec2(az * 9., el * 14.)); // spurs and gullies catch light differently
  vec3 near = vec3(.011, .016, .013) * trees * gully * (amb * 1.6 + uSunCol * uSunPow * .35 * (.6 + .4*sign(-az * uSun.x)));
  near = mix(near, hor, .1 + .1 * smoothstep(.03, 0., el)); // haze pools at the waterline
  vec3 col = cn > .0 ? mix(far * cf, near, cn) : far;
  return vec4(col, cov);
}

// The photo is early spring. Re-grade it through the year: fresh green, deep summer green with the high
// snow thinning, larch stands burning gold and rust in autumn, and snow creeping down the slopes in winter.
vec3 seasonLand(vec3 c, vec2 uv){
  float lum = dot(c, vec3(.2126, .7152, .0722));
  float sum = c.r + c.g + c.b + 1e-4;
  float gr = c.g / sum, rr = c.r / sum;
  float veg = smoothstep(.33, .36, gr) * (1. - smoothstep(.25, .6, lum));
  float dry = smoothstep(.355, .39, rr) * (1. - smoothstep(.3, .8, lum));
  float snowy = smoothstep(.55, .95, lum) * (1. - smoothstep(.36, .4, rr));
  vec3 c1 = mix(c, c * vec3(.88, 1.12, .82), veg);
  c1 = mix(c1, vec3(lum) * vec3(.9, 1.25, .7), dry * .55);
  vec3 c2 = mix(c, c * vec3(.78, 1.08, .72), veg);
  c2 = mix(c2, vec3(lum) * vec3(.75, 1.2, .6), dry * .7);
  // summer melts the lower snow first; soft fractal edges, no blotches
  float melt = snowy * smoothstep(.45, .75, (1. - uv.y) * .9 + fbm2(uv * vec2(40., 18.)) * .45);
  c2 = mix(c2, vec3(lum) * vec3(.45, .45, .47), melt * .6);
  float larch = max(veg, dry * .7) * smoothstep(.36, .58, fbm2(uv * vec2(34., 15.) + 7.));
  float hueN = fbm2(uv * vec2(60., 26.) + 3.);
  vec3 gold = lum * mix(vec3(3.1, 1.75, .38), vec3(3.2, 1.05, .32), hueN);
  vec3 c3 = mix(c, gold, larch * .9);
  c3 = mix(c3, vec3(lum) * vec3(1.55, 1.05, .55), dry * .8);
  // multi-scale noise so drifts have soft, natural edges; forest keeps its dark texture under a dusting
  float drift = fbm2(uv * vec2(46., 20.)); // rotated octaves: no grid-aligned blocks when thresholded
  float cover = smoothstep(.34, .8, uv.y * .7 + drift * .6 + lum * .9);
  vec3 snow = vec3(.93, .98, 1.06) * min(1.3, .28 + lum * 1.3); // follows the photo's light and shade, keeps rock texture
  float forest = max(veg, 1. - smoothstep(.03, .14, lum)); // dense dark forest keeps a light dusting
  vec3 c4 = mix(c * vec3(.84, .9, 1.), snow, cover * mix(.92, .32, forest));
  return c1 * uSeason.x + c2 * uSeason.y + c3 * uSeason.z + c4 * uSeason.w;
}
// Real land photo (sky cut out), spanning ±90° around the view, relit for the time of day.
vec4 landSample(vec3 d, float blur){
  float az = atan(d.x, d.z), el = asin(clamp(d.y, -1., 1.));
  vec2 uv = vec2(.5 + az / PI, (el - uLandGeo.y) / (uLandGeo.x - uLandGeo.y));
  if(uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) return vec4(0.);
  float lod = log2(max(blur / (PI / 4096.), 1.)); // land texture: 4096 texels across 180°
  vec4 t = textureLod(uLand, uv, lod);
  if(t.a < .002) return vec4(0.);
  vec3 c = seasonLand(pow(t.rgb / t.a, vec3(2.2)) * uLandGeo.z, uv);
  return vec4(c * uLandLight, t.a);
}
vec4 land(vec3 d, float blur){ return uLandOn > .5 ? landSample(d, blur + uPixAng * .5) : mountains(d, blur); }

// --- pebble bed detail: two rotated texture layers blended by stone height (kills visible tiling),
// and a parallax height-march so every stone has real relief.
const float BED_TILE = 1.05;   // metres per texture repeat
const float BED_RELIEF = .035; // metres of stone height
const int POM_STEPS = 16;
const mat2 BED_ROT = mat2(.4536, .8912, -.8912, .4536); // ~63°
vec2 bedUvB(vec2 uv){ return BED_ROT * uv + vec2(.37, .71); }
float bedMask(vec2 uv){ return smoothstep(.3, .7, noise2(uv * .42 + 3.1)); }
// whichever stone stands taller wins, so the seam between layers follows pebble outlines
// the large-scale mask decides almost everywhere; height only breaks ties inside the transition bands,
// so flat gravel (where both layers are equally low) doesn't flicker between layers
float bedBlend(float hA, float hB, float m){ return smoothstep(-.12, .12, (m - .5) * 2.4 + (hB - hA) * .7); }
float bedHeight(vec2 uv, vec2 gx, vec2 gy){
  float hA = textureGrad(uBed, uv, gx, gy).a;
  float hB = textureGrad(uBed, bedUvB(uv), BED_ROT * gx, BED_ROT * gy).a;
  return mix(hA, hB, bedBlend(hA, hB, bedMask(uv)));
}

vec3 stars(vec3 d){
  vec3 p = d * 160.; vec3 c = floor(p), f = fract(p);
  float h = hash3(c);
  if(h < .986) return vec3(0.);
  vec3 sp = vec3(hash3(c+11.), hash3(c+23.), hash3(c+37.)) * .6 + .2;
  float r = length(f - sp);
  float mag = pow(hash3(c+5.), 6.) * 3. + .15;
  vec3 tint = mix(vec3(.7, .82, 1.), vec3(1., .7, .43), hash3(c+3.));
  return tint * mag * exp(-r*r*160.) * exp(-.14 / max(d.y, .01));
}

vec3 skyDirect(vec3 d, float lod, bool sharp){
  // the sky in view is computed per pixel (the sky map is far too coarse for it); reflections use the map
  vec3 c = sharp && uPhotoOn > .5 ? skyFull(d, 1.) : skyTex(d, lod);
  // sun disc + aureole
  float sa = acos(clamp(dot(d, uSun), -1., 1.));
  float low = smoothstep(.19, 0., uSun.y);
  float R = .011 + .009*low;
  vec3 tint = mix(vec3(1.), vec3(1., .65, .055), low);
  float r = sa / R;
  // 柔光太阳：日面边缘柔和，外面一圈暖光（原版是边缘很硬的白色圆片）
  vec3 warm = mix(tint, uSunCol, .55);
  float soft = 1. - smoothstep(.55, 1.3, r);
  c += soft * 9. * warm * uSunPow;
  c += warm * uSunPow * (4.*exp(-sa/(2.6*R)) + .9/(1. + pow(sa/(9.*R), 2.)));
  // moon: mottled disc with halo
  float ma = acos(clamp(dot(d, uMoon), -1., 1.));
  if(uMoonPow > 0.){
    vec3 mx = normalize(cross(vec3(0,1,0), uMoon)), my = cross(uMoon, mx);
    vec2 mp = vec2(dot(d, mx), dot(d, my)) / .012;
    if(length(mp) < 1.) c += vec3(1., .98, .94) * (.72 + .28 * fbm2(mp * 2.3 + 4.)) * 1.1 * uMoonPow * 20.;
    c += vec3(.55, .67, 1.) * (.19*exp(-ma/.021) + .009/(1. + pow(ma/.075, 2.))) * uMoonPow * 4.;
  }
  c += stars(d) * uStars;
  return c;
}

// --- water surface gradient: analytic spectrum + sim patch + far ripples
vec3 waveGrad(vec2 p, float fp, out float slopeVar, out float rough){
  vec2 g = vec2(0.); slopeVar = 0.;
  float wpatch = mix(.7, 1.28, noise2(p * .07 + uTime * vec2(.035, .02)));
  // gusts ruffle some patches while others lie glassy and mirror the mountains and clouds
  float gust = noise2(p * .032 + uTime * vec2(.006, .0035)) * .7 + noise2(p * .09 - uTime * vec2(.004, .007)) * .3;
  rough = smoothstep(.36, .66, gust);
  float calm = mix(.16, 1.2, rough);
  for(int i=0;i<32;i++){
    vec4 w = uW[i];
    float k = w.z, s = w.w * k * uWaveAmp * calm * (k > 2. ? wpatch : 1.);
    float kf = k * fp;
    float aa = exp(-.125*kf*kf) * (1. - smoothstep(1.9, PI, kf));
    float th = k * dot(p, w.xy) - uW2[i].x * uTime + uW2[i].y;
    g += w.xy * s * cos(th) * aa;
    g += w.xy * s * .1 * cos(2.*th + 1.1) * aa; // 2nd harmonic
    slopeVar += s*s*.5*(1. - aa*aa);
  }
  // sim patch
  vec2 su = vec2((p.x + ${SIM_SIZE / 2}.) / ${SIM_SIZE}., p.y / ${SIM_SIZE}.);
  if(uSimOn > 0. && su.x > 0. && su.x < 1. && su.y > 0. && su.y < 1.){
    float tx = 1. / ${SIM_N}.;
    float hx = texture(uSim, su + vec2(tx, 0)).r - texture(uSim, su - vec2(tx, 0)).r;
    float hz = texture(uSim, su + vec2(0, tx)).r - texture(uSim, su - vec2(0, tx)).r;
    float edge = min(min(su.x, 1.-su.x), min(su.y, 1.-su.y)) * ${SIM_SIZE}.;
    float fade = smoothstep(0., 2.5, edge) * exp(-fp * 6.);
    g += vec2(hx, hz) * uSimScale * fade;
  }
  // far ripples: expanding capillary-gravity rings
  for(int i=0;i<${MAX_RIPPLES};i++){
    vec4 r = uRip[i];
    if(r.w <= 0.) continue;
    vec2 dv = p - r.xy; float dist = length(dv) + 1e-4;
    float front = 1.29 * r.z, k = 6.28318 / .9;
    float q = (dist - front) / (.7 + .35*r.z);
    float env = exp(-q*q) * exp(-.22*r.z) * sqrt(.45/(dist+.45));
    float kf = k * fp; float aa = exp(-.125*kf*kf);
    g += (dv/dist) * r.w * .5 * cos(k*(dist - front)) * env * aa;
  }
  // rain: each cell of a small grid gets a drop at its own rhythm; rings widen and fade
  if(uWeather.x > .01 && fp < .05){
    vec2 rg = vec2(0.);
    const float cell = .32;
    vec2 ci = floor(p / cell);
    for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
      vec2 id = ci + vec2(i, j);
      float h = hash2(id);
      if(h > uWeather.x) continue;
      float ph = fract(uTime * (1. + h * .6) + hash2(id + 7.3));
      vec2 c = (id + .2 + .6 * vec2(hash2(id + 1.7), hash2(id + 4.1))) * cell;
      vec2 dv = p - c; float dd = length(dv) + 1e-4;
      float x = (dd - ph * .3) / .022;
      float env = (1. - ph) * (1. - ph) * exp(-x * x);
      rg += (dv / dd) * cos(x * 3.) * env * .3;
    }
    g += rg * smoothstep(.05, .012, fp);
    slopeVar += .002 * uWeather.x; // rain dulls the mirror
  }
  return vec3(g, 0.);
}

// Petals and fallen leaves riding the surface: one per grid cell at most, drifting with the current.
vec4 floater(vec2 p, vec2 g, float fp, float cell, float amount, float size, bool petal){
  vec2 q = p - uDrift * (petal ? 1.25 : 1.) + g * .04;
  vec2 id = floor(q / cell);
  float h = hash2(id + (petal ? 13.1 : 0.));
  if(h > amount) return vec4(0.);
  vec2 c = (id + .25 + .5 * vec2(hash2(id + 2.3), hash2(id + 5.9))) * cell;
  float a = hash2(id + 9.7) * 6.2832 + uTime * .04 * (hash2(id + 1.1) - .5);
  vec2 d = mat2(cos(a), -sin(a), sin(a), cos(a)) * (q - c);
  float s = size * (.7 + .6 * hash2(id + 3.3));
  vec2 e = d / vec2(s, s * (petal ? .62 : .42));
  float pinch = petal ? 1. : 1. - .38 * e.x * e.x; // leaves taper to points
  float r = length(vec2(e.x, e.y / max(pinch, .2)));
  float w = fp / s * 1.5 + .03;
  float cov = 1. - smoothstep(1. - w, 1. + w, r);
  if(cov <= 0.) return vec4(0.);
  float k = hash2(id + 6.1);
  vec3 col = petal ? mix(vec3(1., .74, .8), vec3(1., .92, .94), k)
                   : (k < .35 ? vec3(.62, .36, .04) : k < .65 ? vec3(.72, .22, .03) : k < .85 ? vec3(.45, .07, .03) : vec3(.3, .18, .07));
  if(!petal) col *= .82 + .35 * smoothstep(.07, 0., abs(e.y)) * step(abs(e.x), .85); // pale midrib
  return vec4(col, cov * .97 * smoothstep(.07, .02, fp));
}

float ggx(float nh, float a){ float a2 = a*a; float d = nh*nh*(a2-1.)+1.; return a2 / (PI*d*d); }
float fresnel(float ci){
  float n = 1.333; float st2 = (1. - ci*ci) / (n*n); if(st2 >= 1.) return 1.;
  float ct = sqrt(1. - st2);
  float rs = (ci - n*ct) / (ci + n*ct), rp = (n*ci - ct) / (n*ci + ct);
  return .5*(rs*rs + rp*rp);
}
vec3 aces(vec3 c){ return clamp((c*(2.51*c + .03)) / (c*(2.43*c + .59) + .14), 0., 1.); }

void main(){
  vec2 ndc = vUv * 2. - 1.;
  vec3 rd = normalize(uFwd + ndc.x*uTan.x*uRight + ndc.y*uTan.y*uUp);
  vec3 col;
  if(rd.y >= -.0004){
    col = skyDirect(rd, 0., true);
    vec4 m = land(rd, 0.);
    col = mix(col, m.rgb, m.a);
  } else {
    float t = -uEye.y / rd.y;
    vec3 P = uEye + rd * t;
    vec2 p = P.xz;
    float fp = t * uPixAng / sqrt(max(-rd.y, .02));
    float sv;
    float rough;
    vec2 g = waveGrad(p, fp, sv, rough).xy;
    vec3 n = normalize(vec3(-g.x, 1., -g.y));
    vec3 v = -rd;
    float nv = max(dot(n, v), 1e-3);
    float F = fresnel(nv) * mix(.82, 1., pow(max(1. - nv, 0.), 8.));

    // reflection
    vec3 r = reflect(rd, n);
    r.y = sqrt(r.y*r.y + .00012); r = normalize(r);
    float lod = max(clamp(log2(fp*1300.), 0., 7.), min(3., log2(sqrt(sv)*120. + 1e-4)));
    vec3 refl = skyDirect(r, max(lod - .3, 0.), false);
    vec4 m = land(r, sqrt(sv) * .9 + fp*.02);
    refl = mix(refl, m.rgb, m.a);

    // refraction into the pebble bed
    vec3 tr = refract(rd, n, 1./1.333);
    float z = max(P.z, 0.);
    float D = uDepth * (.38 + .2*z + .055*pow(z, 1.6) + .02*sin(P.x*.9 + z*.4));
    vec3 B = P + tr * (D / max(-tr.y, .12));
    vec2 buv = B.xz / BED_TILE + vec2(.35, .41);
    vec2 gx = dFdx(buv), gy = dFdy(buv);
    // parallax: march the refracted ray down through the stone heights (near field only)
    float relief = BED_RELIEF / BED_TILE * smoothstep(9., 3., t);
    vec2 stepUv = tr.xz / max(-tr.y, .2) * relief; // uv shift per unit of height
    vec2 uv = buv - stepUv * .5;                   // enter at the stone tops
    if(relief > 1e-4){
      float dl = 1. / float(POM_STEPS);
      float layer = 1., h = bedHeight(uv, gx, gy), prevH = h, prevL = 1.;
      for(int i=0;i<POM_STEPS;i++){
        if(h >= layer) break;
        prevH = h; prevL = layer;
        layer -= dl; uv += stepUv * dl;
        h = bedHeight(uv, gx, gy);
      }
      float above = prevL - prevH, below = h - layer; // secant refine between the last two layers
      uv -= stepUv * dl * (1. - above / max(above + below, 1e-4));
    }
    vec2 uvB = bedUvB(uv), gxB = BED_ROT * gx, gyB = BED_ROT * gy;
    vec4 aA = textureGrad(uBed, uv, gx, gy), aB = textureGrad(uBed, uvB, gxB, gyB);
    float wB = bedBlend(aA.a, aB.a, bedMask(uv));
    vec4 alb = mix(aA, aB, wB);
    vec3 nA = textureGrad(uBedN, uv, gx, gy).xyz * 2. - 1.;
    vec3 nB = textureGrad(uBedN, uvB, gxB, gyB).xyz * 2. - 1.;
    nB.xy = transpose(BED_ROT) * nB.xy; // back into layer A's frame
    vec3 tn = normalize(mix(nA, nB, wB));
    vec3 bn = normalize(vec3(tn.x, tn.z, tn.y));
    float silt = (1. - uClarity)*(1. - uClarity)*2.6;
    vec3 sigma = vec3(.34, .1, .066) + silt*vec3(.75, .89, 1.);
    float path = length(B - P);

    // light under water: sun (or moon) refracted through the surface
    vec3 L = uSunPow >= uMoonPow ? uSun : uMoon;
    vec3 Lc = uSunPow >= uMoonPow ? uSunCol * uSunPow : uMoonCol * uMoonPow;
    vec3 lw = refract(-L, n, 1./1.333);
    vec3 lwFlat = refract(-L, vec3(0,1,0), 1./1.333);
    float Lup = max(-lw.y, .05);
    // caustics: ray-compression Jacobian of the refracted light footprint on the bed
    vec2 cp = P.xz + lw.xz * (D / Lup);
    vec2 cf = P.xz + lwFlat.xz * (D / max(-lwFlat.y, .05));
    float area = abs(determinant(mat2(dFdx(cp), dFdy(cp))));
    float areaF = abs(determinant(mat2(dFdx(cf), dFdy(cf))));
    float flux = clamp(areaF / max(area, .2*areaF), .22, 4.2);
    float caustic = 1. + (flux - 1.) * .35 * exp(-2.*silt*D) * smoothstep(0., .2, L.y);
    vec3 Tl = exp(-sigma * D / Lup);
    float ndl = max(dot(bn, -lw), 0.);
    // stones shade their neighbours: short march toward the light through the height field
    float shadow = 1.;
    if(relief > 1e-4 && ndl > 0.){
      vec2 sUv = -lw.xz / max(-lw.y, .2) * relief;
      float h0 = alb.a;
      for(int i=1;i<=6;i++){
        float s = float(i) / 6.;
        float hh = bedHeight(uv + sUv * s * (1. - h0), gx, gy);
        shadow = min(shadow, 1. - .7 * smoothstep(0., .1, hh - (h0 + s * (1. - h0))));
      }
    }
    ndl *= shadow;
    vec3 amb = skyTex(vec3(.12, .98, .08), 6.5) * .65;
    vec3 bedLight = Lc * 1.45 * ndl * Tl * caustic + amb * exp(-sigma * D);
    float ao = mix(.4, 1., alb.a);
    vec3 bed = alb.rgb * bedLight * ao;
    vec3 Tv = exp(-sigma * path);
    vec3 scat = mix(vec3(.008, .02, .03), vec3(.022, .036, .034), clamp(silt, 0., 1.)) * (uDay + .014*uNight) * 1.4;
    scat += amb * .012;
    vec3 refr = bed * Tv + scat * (1. - Tv);

    col = refr * (1. - F) + refl * F;

    // glints: sharp GGX + broad sunset road
    float bre = uBreeze / 100.;
    vec3 h = normalize(L + v);
    float nh = max(dot(n, h), 0.), nl = max(dot(n, L), 0.);
    bool moonLit = uMoonPow > uSunPow;
    float a1 = sqrt(.0005 + sv*.35 + .00008*uBreeze) * (moonLit ? .55 : 1.);
    float spec = ggx(nh, a1) * fresnel(max(dot(h, v), 0.)) / (4. * nv) ;
    vec3 glintCol = mix(Lc, vec3(1., .55, .2) * length(Lc), .7*uSunset);
    col += glintCol * spec * (moonLit ? 1.2 : (1. - .55*uSunset) * .55) * step(0., L.y);
    float a2 = .11 + .045*bre;
    vec3 road = mix(Lc, vec3(1., .4, .065) * length(Lc), .9*uSunset);
    col += road * ggx(nh, a2) * fresnel(max(dot(h, v), 0.)) / (4.*nv) * nl * (.055 + .82*uSunset) * 2.2 * step(uMoonPow, uSunPow) * mix(.08, 1., rough); // glassy patches mirror a sharp sun, not a broad road

    vec3 lit = Lc * (max(dot(n, L), 0.) * .9 + .35) + amb * 2.2; // thin leaves glow when the low sun shines through
    if(uWeather.w > .01){ vec4 f = floater(p, g, fp, .9, uWeather.w * .5, .075, false); col = mix(col, f.rgb * lit, f.a); }
    if(uWeather.z > .01){ vec4 f = floater(p, g, fp, .3, uWeather.z * .45, .02, true); col = mix(col, f.rgb * lit, f.a); }
  }
  col *= uExposure;
  col = aces(col);
  col = pow(col, vec3(1./2.2));
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))));
  o = vec4(col + (ign - .5)/255., 1.);
}`

// Falling weather: rain streaks, snow, petals and leaves, placed procedurally in a box in front of the camera.
const PART_VS = `#version 300 es
precision highp float;
uniform vec3 uEye, uFwd, uUp, uRight;
uniform vec2 uTan;
uniform float uTime, uViewH;
uniform int uKind; // 0 rain, 1 snow, 2 petal, 3 leaf
out float vAlpha, vAngle, vHue;
flat out int vKind;
float h1(float n){ return fract(sin(n) * 43758.5453); }
void main(){
  float id = float(gl_VertexID) + float(uKind) * 10000.;
  float speed = uKind == 0 ? 7.5 : uKind == 1 ? .75 : uKind == 2 ? .5 : 1.;
  const float H = 7.;
  float t = uTime * speed / H + h1(id * 1.3);
  float y = H * (1. - fract(t));
  float cyc = floor(t);
  float rx = h1(id * 2.1 + cyc * 3.7), rz = h1(id * 3.3 + cyc * 5.1);
  vec3 P = vec3((rx - .5) * 26., y, mix(1.6, 28., rz * rz));
  float sway = uKind == 0 ? 0. : uKind == 1 ? .35 : .6;
  P.x += sin(uTime * (.6 + h1(id) * .8) + id) * sway + uTime * (uKind == 3 ? .35 : .12);
  P.z += cos(uTime * (.5 + h1(id * 7.) * .6) + id * 1.7) * sway * .6;
  P.x = mod(P.x + 13., 26.) - 13.;
  vec3 v = P - uEye;
  float z = dot(v, uFwd);
  vKind = uKind; vHue = h1(id * 11.);
  vAngle = uTime * (uKind == 3 ? 2.2 : 1.3) * (h1(id * 9.) - .5) * 2. + id;
  if(z < .3){ gl_Position = vec4(2., 2., 2., 1.); gl_PointSize = 0.; vAlpha = 0.; return; }
  gl_Position = vec4(dot(v, uRight) / (z * uTan.x), dot(v, uUp) / (z * uTan.y), 0., 1.);
  float sizeM = uKind == 0 ? .45 : uKind == 1 ? .032 : uKind == 2 ? .024 : .065;
  float px = sizeM / z * uViewH / (2. * uTan.y);
  gl_PointSize = clamp(px, 1.5, uKind == 3 ? 56. : 26.);
  vAlpha = (uKind == 0 ? .32 : .92) * smoothstep(28., 16., z) * smoothstep(0., .5, y) * clamp(px / 2., .35, 1.) * smoothstep(1.2, 3.5, z); // no giant flakes against the lens
}`

const PART_FS = `#version 300 es
precision highp float;
in float vAlpha, vAngle, vHue;
flat in int vKind;
uniform vec3 uCol[4]; // display-space tint per kind
out vec4 o;
void main(){
  vec2 q = gl_PointCoord * 2. - 1.;
  float a;
  vec3 c = uCol[vKind];
  if(vKind == 0){
    a = smoothstep(.1, 0., abs(q.x)) * (1. - abs(q.y));
  } else if(vKind == 1){
    a = smoothstep(1., .15, length(q));
  } else {
    vec2 r = mat2(cos(vAngle), -sin(vAngle), sin(vAngle), cos(vAngle)) * q;
    float flip = .3 + .7 * abs(cos(vAngle * .7)); // tumbling foreshortens the shape
    vec2 e = r / vec2(1., (vKind == 2 ? .62 : .42) * flip);
    a = smoothstep(1., .8, length(e));
    c *= vKind == 3 ? mix(vec3(.85, .45, .08), vec3(.7, .18, .05), vHue) : mix(vec3(1., .8, .85), vec3(1., .93, .95), vHue);
  }
  o = vec4(c, a * vAlpha);
  if(o.a < .01) discard;
}`

// ---------------------------------------------------------------- GL helpers

function compile(gl, fs, vs = VS) {
  const p = gl.createProgram()
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    gl.attachShader(p, s)
  }
  gl.linkProgram(p)
  return p
}

function checkProgram(gl, p) {
  if (gl.getProgramParameter(p, gl.LINK_STATUS)) return
  const logs = gl.getAttachedShaders(p).map((s) => gl.getShaderInfoLog(s)).join('\n')
  throw new Error('Shader failed: ' + logs + gl.getProgramInfoLog(p))
}

function uniforms(gl, p) {
  const u = {}
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '')
    u[name] = gl.getUniformLocation(p, name)
  }
  return u
}

function target(gl, w, h, mips) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  const levels = mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, w, h)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const fb = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  return { tex, fb, w, h }
}

async function loadTexture(gl, url, srgb, aniso) {
  const blob = await (await fetch(url)).blob()
  // alpha carries stone height, so it must not be premultiplied into the colour
  const img = await createImageBitmap(blob, { imageOrientation: 'flipY', colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img)
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
  if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8)
  return tex
}

async function imageTexture(gl, url, { premultiply = false, mips = false, repeatS = false } = {}) {
  // ImageBitmap uploads ignore UNPACK_PREMULTIPLY_ALPHA, so premultiply while decoding
  const img = await createImageBitmap(await (await fetch(url)).blob(), { imageOrientation: 'flipY', colorSpaceConversion: 'none', premultiplyAlpha: premultiply ? 'premultiply' : 'none' })
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img)
  if (mips) gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeatS ? gl.REPEAT : gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}

// Photographic sky keyframes (CC0 Poly Haven "qwantani" series) and land (CC0 "lago_disola", sky cut out).
async function loadPhotos(gl) {
  const meta = await (await fetch('assets/sky.json')).json()
  const [landTex, ...keyTex] = await Promise.all([
    imageTexture(gl, 'assets/land.webp', { premultiply: true, mips: true }),
    ...meta.keys.map((k) => imageTexture(gl, `assets/sky/${k.name}.webp`, { repeatS: true })),
  ])
  meta.keys.forEach((k, i) => (k.tex = keyTex[i]))
  return { meta, landTex, timeline: keyTimeline(meta.keys, 80), timelineDoy: 80 }
}

// Each keyframe sits at the hour our sun reaches its capture altitude, on its side of noon.
function keyTimeline(keys, doy) {
  const hs = Array.from({ length: 24 * 12 + 1 }, (_, i) => i / 12)
  const alts = hs.map((h) => sunAt(h, doy).alt / DEG)
  const noonI = alts.indexOf(Math.max(...alts))
  const at = (alt, side) => {
    if (side === 'am') { for (let i = 0; i <= noonI; i++) if (alts[i] >= alt) return hs[i]; return hs[noonI] - 0.1 }
    for (let i = noonI; i < hs.length; i++) if (alts[i] <= alt) return hs[i]
    return hs[noonI] + 0.1
  }
  const line = keys.map((k) => ({ k, h: at(k.alt, k.side) }))
  const night = keys.find((k) => k.name === 'night')
  if (night) line.push({ k: night, h: at(night.alt, 'am') }) // hold the night sky until dawn
  line.sort((a, b) => a.h - b.h)
  for (let i = 1; i < line.length; i++) if (line[i].h <= line[i - 1].h) line[i].h = line[i - 1].h + 0.02
  return line
}

function blendAt(line, hours) {
  let i = line.findIndex((e) => e.h > hours) - 1
  if (i === -2) i = line.length - 1 // after the last key
  if (i === -1) i = line.length - 1 // before the first key
  const a = line[i], b = line[(i + 1) % line.length]
  const span = (b.h - a.h + 24) % 24 || 24
  const t = ((hours - a.h + 24) % 24) / span
  return { a: a.k, b: b.k, t: smooth(0, 1, t) }
}

// ---------------------------------------------------------------- sky / sun model

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

// Slow the sun down around sunset so golden hour and afterglow last longer: clock hours relative to
// sunset map onto solar hours through these knots (identity outside them). The window from 2.5 h
// before to 1.5 h after sunset runs at ~0.48× speed; the late afternoon and early night catch up.
const EVENING_KNOTS = [[-4.5, -4.5], [-2.5, -1.3], [1.5, 0.6], [4, 4]]
function stretchEvening(hours, sunset) {
  const d = hours - sunset
  const K = EVENING_KNOTS
  if (d <= K[0][0] || d >= K[K.length - 1][0]) return hours
  for (let i = 0; i < K.length - 1; i++) {
    const [x0, y0] = K[i], [x1, y1] = K[i + 1]
    if (d <= x1) return sunset + y0 + ((d - x0) / (x1 - x0)) * (y1 - y0)
  }
  return hours
}

// Sun altitude/azimuth at a Californian lake. Like the original, the visitor's clock is read as local
// lake time, so sunset always falls around 7 p.m. in summer regardless of where they are.
// ponytail: ignores equation of time (±15 min); plug in a full ephemeris if it matters.
function sunAt(hours, doy = 80, lat = 38.1 * DEG) {
  const now = new Date()
  const dec = 23.44 * DEG * Math.sin((2 * Math.PI * (284 + doy)) / 365)
  const dst = now.getMonth() >= 2 && now.getMonth() <= 10 // US daylight time, roughly Mar–Nov
  const offset = (dst ? 1 : 0) + 0.19 // lake sits ~3° west of its zone meridian
  const H0 = Math.acos(Math.min(1, Math.max(-1, -Math.tan(lat) * Math.tan(dec))))
  const sunsetClock = 12 + H0 / (15 * DEG) + offset
  const solar = stretchEvening(hours, sunsetClock) - offset
  const H = (solar - 12) * 15 * DEG
  const alt = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H))
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) + Math.PI
  const azSet = Math.atan2(Math.sin(H0), Math.cos(H0) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) + Math.PI
  return { alt, az, azSet }
}

const dirFrom = (alt, relAz) => [Math.cos(alt) * Math.sin(relAz), Math.sin(alt), Math.cos(alt) * Math.cos(relAz)]

export function lighting(hours, doy = 80) {
  const s = sunAt(hours, doy)
  const rel = s.az - s.azSet // camera always faces the sunset
  const sun = dirFrom(s.alt, rel)
  const altDeg = s.alt / DEG
  // 月亮：原版放在太阳对面，也就是镜头背后，画面里看不到。改成夜里挂在正前方偏左的山谷上空：
  // 天黑后从低处慢慢升起，夜深时最高（约 10°），天亮前再落下，湖面上会有一道月光
  const deep = smooth(-3, -30, altDeg)
  const moonAlt = (3 + 7 * deep) * DEG
  const moon = dirFrom(moonAlt, -0.12 - 0.16 * deep)
  const y = Math.sin(s.alt)
  const daylight = Math.pow(smooth(-12, 12, altDeg), 0.72)
  const night = 1 - smooth(-12, -3, altDeg)
  const sunPow = smooth(-0.6, 4, altDeg)
  const moonPow = 0.05 * smooth(0, 3, moonAlt / DEG) * night
  const sunCol = [1, Math.min(1, Math.max(0.32, 0.44 + 2 * y)), Math.min(0.94, Math.max(0.12, 0.21 + 3 * y))]
  const sunset = smooth(14, 4, altDeg) * smooth(-8.5, -1, altDeg)
  const breeze = Math.round(8 + 80 * Math.max(0, Math.cos(((hours - 13) * Math.PI) / 14)) ** 2)
  return { sun, moon, sunPow, moonPow, sunCol, daylight, night, sunset, breeze, altDeg, clarity: 0.74 + 0.26 * smooth(-6, 0, altDeg) }
}

// ---------------------------------------------------------------- waves

function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

function makeWaves() {
  const rnd = mulberry(11)
  const fixed = [[239, 0.0085, 0.1], [109, 0.012, -0.35], [17.3, 0.02, 0.5], [21.7, 0.018, -0.6], [9.3, 0.026, 0.25], [5.81, 0.031, -0.15]]
  const m = 26
  const modes = fixed.map(([l, s, a]) => ({ l, s, a }))
  for (let i = 0; i < m; i++) {
    const l = 3.78 * Math.pow(0.035 / 3.78, i / (m - 1))
    const tiny = l > 0.6 ? 1 : 0.12 + 0.88 * Math.pow(l / 0.6, 1.5) // short, fast ripples read as flicker; keep them faint
    modes.push({ l, s: (0.03 + 0.03 * rnd()) * tiny, a: (rnd() - 0.5) * 2.4 })
  }
  const w = new Float32Array(32 * 4)
  const w2 = new Float32Array(32 * 2)
  modes.forEach(({ l, s, a }, i) => {
    const k = (2 * Math.PI) / l
    const omega = Math.sqrt((9.81 * k + (0.0728 / 998.2) * k ** 3) * Math.tanh(k * 18))
    w.set([Math.sin(a), -Math.cos(a), k, s / k], i * 4)
    w2.set([omega, rnd() * Math.PI * 2], i * 2)
  })
  return { w, w2 }
}

// ---------------------------------------------------------------- lake

export async function createLake(canvas, { view = 'alt', seed = 0 } = {}) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' })
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) throw new Error('WebGL2 float targets unavailable')
  gl.getExtension('OES_texture_float_linear')
  gl.getExtension('KHR_parallel_shader_compile')
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
  const V = VIEWS[view] || VIEWS.alt
  const bedRes = matchMedia('(pointer: coarse)').matches ? '-2k' : ''

  const progs = { sky: compile(gl, SKY_FS), sim: compile(gl, SIM_FS), water: compile(gl, WATER_FS), part: compile(gl, PART_FS, PART_VS) }
  const [bed, bedN, photos] = await Promise.all([
    // 4K pebbles (albedo + height in alpha, and normals); phones get 2K to save GPU memory
    loadTexture(gl, `assets/bed${bedRes}.webp`, true, aniso),
    loadTexture(gl, `assets/bed_nor${bedRes}.webp`, false, aniso),
    loadPhotos(gl).catch((e) => { console.warn('Photo sky unavailable, using procedural sky', e); return null }),
  ])
  Object.values(progs).forEach((p) => checkProgram(gl, p))
  const U = Object.fromEntries(Object.entries(progs).map(([k, p]) => [k, uniforms(gl, p)]))

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  const sky = target(gl, SKY_W, SKY_H, true)
  const sim = [target(gl, SIM_N, SIM_N), target(gl, SIM_N, SIM_N)]
  for (const t of sim) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT) }
  const waves = makeWaves()

  // ------------ state
  let hours = 12
  let landLight = [1, 1, 1]
  let skyZenith = 0.15
  let L = lighting(hours)
  let skyDirty = true
  let lastSky = 0
  const wind = [0, 0]
  let simAwakeUntil = -1
  let simAcc = 0
  const splats = []
  const ripples = []
  let pr = 1
  const cam = { eye: [0, V.eye, 0], fwd: [0, 0, 1], up: [0, 1, 0], right: [1, 0, 0], tanH: 1, tanV: 1 }

  let dynScale = 1
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight
    const dpr = window.devicePixelRatio || 1
    const coarse = matchMedia('(pointer: coarse)').matches
    // up to full Retina sharpness; dynScale backs off automatically if the GPU can't hold ~50 fps
    pr = Math.min(dpr, coarse ? 1.75 : 2, Math.sqrt((coarse ? 2.2e6 : 4.6e6) / (w * h))) * dynScale
    canvas.width = Math.round(w * pr)
    canvas.height = Math.round(h * pr)
    const p = V.pitch
    cam.fwd = [0, -Math.sin(p), Math.cos(p)]
    cam.up = [0, Math.cos(p), Math.sin(p)]
    let tanV = Math.tan(V.halfV)
    const aspect = w / h
    tanV = Math.min(tanV, Math.tan(V.maxHalfH) / aspect)
    cam.tanV = tanV
    cam.tanH = tanV * aspect
  }
  resize()

  function ray(x, y) {
    const nx = (x / canvas.clientWidth) * 2 - 1, ny = 1 - (y / canvas.clientHeight) * 2
    const d = [0, 1, 2].map((i) => cam.fwd[i] + nx * cam.tanH * cam.right[i] + ny * cam.tanV * cam.up[i])
    const l = Math.hypot(...d)
    return d.map((v) => v / l)
  }

  // Screen point → water plane (metres), or null for sky/land.
  function worldAt(x, y) {
    const d = ray(x, y)
    if (d[1] >= -0.002) return null
    const t = -cam.eye[1] / d[1]
    if (t > 2500) return null
    return [cam.eye[0] + d[0] * t, cam.eye[2] + d[2] * t]
  }

  function project(wx, wz) {
    const v = [wx - cam.eye[0], -cam.eye[1], wz - cam.eye[2]]
    const z = v[0] * cam.fwd[0] + v[1] * cam.fwd[1] + v[2] * cam.fwd[2]
    if (z <= 0.01) return null
    const px = (v[0] * cam.right[0] + v[1] * cam.right[1] + v[2] * cam.right[2]) / (z * cam.tanH)
    const py = (v[0] * cam.up[0] + v[1] * cam.up[1] + v[2] * cam.up[2]) / (z * cam.tanV)
    return [(px * 0.5 + 0.5) * canvas.clientWidth, (0.5 - py * 0.5) * canvas.clientHeight]
  }

  const inPatch = (x, z) => x > -SIM_SIZE / 2 + 0.6 && x < SIM_SIZE / 2 - 0.6 && z > 0.3 && z < SIM_SIZE - 0.6
  const toUv = (x, z) => [(x + SIM_SIZE / 2) / SIM_SIZE, z / SIM_SIZE]
  const now = () => performance.now() / 1000

  function splat(x, z, radius, height, vel) {
    const [u, v] = toUv(x, z)
    splats.push([u, v, radius / SIM_SIZE, height, vel])
    simAwakeUntil = now() + SIM_SLEEP_S
  }

  function farRipple(x, z, strength) {
    ripples.push({ x, z, t0: now(), s: strength })
    if (ripples.length > MAX_RIPPLES) ripples.shift()
  }

  // Drop: a puncture now, the outward ring 78 ms later. Longer holds splash harder.
  function tap(x, z, holdMs = 0) {
    const hold = Math.min(holdMs, 400)
    const k = (0.82 + (hold / 400) * 0.35) * V.ripple
    if (!inPatch(x, z)) return farRipple(x, z, k * 0.9)
    const r = 0.07 + 0.012 * z
    splat(x, z, r * 0.6, -0.16 * k, -0.05 * k)
    setTimeout(() => splat(x, z, r, 0, -0.06 * k), 78)
  }

  let lastFarDrag = 0
  function drag(x0, z0, x1, z1, dt) {
    const len = Math.hypot(x1 - x0, z1 - z0)
    const speed = len / Math.max(dt, 1e-3)
    if (!inPatch(x1, z1)) {
      if (performance.now() - lastFarDrag > 240) { lastFarDrag = performance.now(); farRipple(x1, z1, Math.min(0.7, 0.2 + 0.06 * speed) * V.ripple) }
      return
    }
    const E = Math.min(2.8, 0.25 + 0.32 * speed) * V.ripple
    const step = 0.035
    const n = Math.min(24, Math.max(1, Math.ceil(len / step)))
    for (let i = 1; i <= n; i++) {
      const t = i / n
      const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t
      splat(x, z, 0.045 + 0.008 * z, -0.012 * E * (len / n / step), -0.02 * E * (len / n / step))
    }
  }

  // Hold: a gentle pressure dimple while the pointer is down.
  function press(x, z, amount) {
    if (!inPatch(x, z)) return
    splat(x, z, 0.06, -0.004 * amount, 0)
  }

  // The year: season weights, weather and the day of year that sets the sun's path.
  let season = { weights: [1, 0, 0, 0], rain: 0, snow: 0, petals: 0, petalsFloat: 0, leaves: 0, leavesFloat: 0, overcast: 0, breeze: 40, doy: 80 }
  const drift = [0, 0]
  function setYear(state) {
    season = state
    if (photos && Math.abs(state.doy - photos.timelineDoy) > 3) {
      photos.timeline = keyTimeline(photos.meta.keys, state.doy)
      photos.timelineDoy = state.doy
    }
    hours = ((state.hours % 24) + 24) % 24
    L = lighting(hours, state.doy)
    L.breeze = state.breeze
    const clear = 1 - 0.92 * Math.pow(state.overcast, 0.7) // clouds swallow the direct sun
    L.sunPow *= clear
    L.sunset *= clear
    skyDirty = true
  }

  function setHours(h) {
    if (Math.abs(h - hours) < 1e-4) return
    hours = ((h % 24) + 24) % 24
    L = lighting(hours, season.doy)
    skyDirty = true
  }

  function renderSky(t) {
    const p = progs.sky, u = U.sky
    gl.useProgram(p)
    gl.bindFramebuffer(gl.FRAMEBUFFER, sky.fb)
    gl.viewport(0, 0, SKY_W, SKY_H)
    gl.uniform3fv(u.uSun, L.sun)
    gl.uniform3fv(u.uMoon, L.moon)
    gl.uniform3fv(u.uSunCol, L.sunCol)
    gl.uniform1f(u.uSunI, 20)
    gl.uniform1f(u.uMoonI, L.moonPow > 0 && L.sun[1] < 0 ? 20 * 0.0016 : 0)
    const blend = skyUniforms(u, 0)
    if (photos) {
      const { a, b, t: mix } = blend
      const zen = a.zenith.map((v, i) => v + (b.zenith[i] - v) * mix)
      const ref = photos.meta.land.refZenith
      const direct = L.sunPow * smooth(-2, 25, L.altDeg) * 0.45
      landLight = zen.map((v, i) => 0.6 * Math.min(1.3, v / ref[i]) + direct * L.sunCol[i] + 0.2 * L.moonPow * [0.55, 0.68, 1][i])
      skyZenith = 0.2126 * zen[0] + 0.7152 * zen[1] + 0.0722 * zen[2]
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, sky.tex)
    gl.generateMipmap(gl.TEXTURE_2D)
    lastSky = t
    skyDirty = false
  }

  // Uniforms of the shared sky chunk; the two photo keyframes go on texture units `unit` and `unit + 1`.
  function skyUniforms(u, unit) {
    gl.uniform1f(u.uCloud, 1.25 + seed * 0.12 + season.overcast * 0.8)
    gl.uniform1f(u.uOvercast, season.overcast * 0.85)
    gl.uniform2fv(u.uWind, wind)
    gl.uniform1f(u.uCloudSeed, seed * 13.7)
    gl.uniform1f(u.uPhotoOn, photos ? 1 : 0)
    if (!photos) return null
    const blend = blendAt(photos.timeline, hours)
    gl.uniform4f(u.uRange, blend.a.lo, blend.a.hi, blend.b.lo, blend.b.hi)
    gl.uniform1f(u.uMix, blend.t)
    // every keyframe was shot with the sun at 216°; turn the photo so its glow sits on our sun
    gl.uniform1f(u.uRot, 216 * DEG - Math.atan2(L.sun[0], L.sun[2]))
    ;[blend.a.tex, blend.b.tex].forEach((tex, i) => { gl.activeTexture(gl.TEXTURE0 + unit + i); gl.bindTexture(gl.TEXTURE_2D, tex) })
    gl.uniform1i(u.uKeyA, unit)
    gl.uniform1i(u.uKeyB, unit + 1)
    return blend
  }

  let cur = 0
  function stepSim(n) {
    const p = progs.sim, u = U.sim
    gl.useProgram(p)
    gl.viewport(0, 0, SIM_N, SIM_N)
    gl.uniform2f(u.uTx, 1 / SIM_N, 1 / SIM_N)
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1i(u.uS, 0)
    for (let i = 0; i < n; i++) {
      const batch = splats.splice(0, 16)
      gl.uniform1i(u.uN, batch.length)
      if (batch.length) {
        const a = new Float32Array(64), b = new Float32Array(32)
        batch.forEach((s, j) => { a.set([s[0], s[1], s[2], 0], j * 4); b.set([s[3], s[4]], j * 2) })
        gl.uniform4fv(u.uSplat, a)
        gl.uniform2fv(u.uAmt, b)
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, sim[1 - cur].fb)
      gl.bindTexture(gl.TEXTURE_2D, sim[cur].tex)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      cur = 1 - cur
    }
  }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  let waveTime = 0
  let last = now()
  let raf = 0
  let onFirstFrame = null
  let frames = 0
  let frameTimes = 0, frameCount = 0
  let breezeNow = L.breeze

  function frame() {
    raf = requestAnimationFrame(frame)
    const t = now()
    const dt = Math.min(0.1, t - last)
    last = t
    waveTime += dt * (reduced ? 0.28 : 1)
    breezeNow += (L.breeze - breezeNow) * Math.min(1, dt * 2)
    wind[0] += dt * (0.0009 + breezeNow * 0.00003)
    wind[1] += dt * 0.0004
    drift[0] += dt * 0.045; drift[1] -= dt * 0.028 // a slow current toward the near shore
    frameTimes += dt; frameCount++
    if (frameCount === 90) {
      const avg = frameTimes / frameCount
      if (avg > 1 / 48 && dynScale > 0.55) { dynScale *= 0.85; resize() }
      else if (avg < 1 / 58 && dynScale < 1) { dynScale = Math.min(1, dynScale * 1.08); resize() }
      frameTimes = 0; frameCount = 0
    }
    if (skyDirty || t - lastSky > 0.25) renderSky(t)

    if (t < simAwakeUntil || splats.length) {
      simAcc += dt * SIM_HZ
      const n = Math.min(4, Math.floor(simAcc))
      simAcc = Math.min(simAcc - n, 4)
      if (splats.length > 64) splats.splice(0, splats.length - 64)
      if (n) stepSim(n)
    }
    for (let i = ripples.length - 1; i >= 0; i--) if (t - ripples[i].t0 > 10) ripples.splice(i, 1)

    const p = progs.water, u = U.water
    gl.useProgram(p)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.uniform2f(u.uRes, canvas.width, canvas.height)
    gl.uniform2f(u.uTan, cam.tanH, cam.tanV)
    gl.uniform3fv(u.uEye, cam.eye)
    gl.uniform3fv(u.uFwd, cam.fwd)
    gl.uniform3fv(u.uUp, cam.up)
    gl.uniform3fv(u.uRight, cam.right)
    gl.uniform1f(u.uPixAng, (2 * cam.tanV) / canvas.height)
    gl.uniform1f(u.uTime, waveTime)
    gl.uniform1f(u.uWaveAmp, 0.62 * ((0.62 * Math.max(0.12, breezeNow)) / 88 + 0.06))
    gl.uniform1f(u.uBreeze, breezeNow)
    gl.uniform4fv(u.uW, waves.w)
    gl.uniform2fv(u.uW2, waves.w2)
    const rip = new Float32Array(MAX_RIPPLES * 4)
    ripples.forEach((r, i) => rip.set([r.x, r.z, t - r.t0, r.s], i * 4))
    gl.uniform4fv(u.uRip, rip)
    gl.uniform3fv(u.uSun, L.sun)
    gl.uniform3fv(u.uSunCol, L.sunCol)
    gl.uniform3fv(u.uMoon, L.moon)
    gl.uniform3fv(u.uMoonCol, [0.55, 0.68, 1])
    gl.uniform1f(u.uSunPow, L.sunPow)
    gl.uniform1f(u.uMoonPow, L.moonPow)
    gl.uniform1f(u.uNight, L.night)
    gl.uniform1f(u.uDay, L.daylight)
    gl.uniform1f(u.uSunset, L.sunset)
    gl.uniform1f(u.uStars, L.night * (1 - 0.5 * L.moonPow / 0.05))
    // eye adaptation: dusk and night are lifted toward a readable, moonlit look (the original brightens nights ~6×)
    const adapt = photos ? Math.min(10, Math.max(1, Math.pow(0.15 / skyZenith, 0.47))) : 1 + L.night * 5
    gl.uniform1f(u.uExposure, 0.78 * adapt)
    gl.uniform1f(u.uSeed, seed)
    gl.uniform1f(u.uDepth, V.depth)
    gl.uniform1f(u.uClarity, V.clarity * 0.5 + L.clarity * 0.5)
    gl.uniform1f(u.uSimOn, t < simAwakeUntil + 4 ? 1 : 0)
    gl.uniform1f(u.uSimScale, 9)
    gl.uniform4fv(u.uSeason, season.weights)
    gl.uniform4f(u.uWeather, season.rain, season.snow, season.petalsFloat, season.leavesFloat)
    gl.uniform2fv(u.uDrift, drift)
    gl.uniform1f(u.uLandOn, photos ? 1 : 0)
    if (photos) {
      const g = photos.meta.land
      gl.uniform3f(u.uLandGeo, g.elTop * DEG, g.elBottom * DEG, g.white)
      gl.uniform3fv(u.uLandLight, landLight)
    }
    skyUniforms(u, 5)
    const texs = [['uSky', sky.tex], ['uBed', bed], ['uBedN', bedN], ['uSim', sim[cur].tex], ['uLand', photos ? photos.landTex : bed]]
    texs.forEach(([name, tex], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u[name], i) })
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.activeTexture(gl.TEXTURE0)
    drawWeather()

    if (++frames === 2 && onFirstFrame) onFirstFrame()
  }

  const PART_COUNTS = [1400, 2800, 380, 170] // rain, snow, petals, leaves at full strength
  function drawWeather() {
    const amounts = [season.rain, season.snow, season.petals, season.leaves]
    if (amounts.every((a) => a < 0.01)) return
    const p = progs.part, u = U.part
    gl.useProgram(p)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.uniform3fv(u.uEye, cam.eye); gl.uniform3fv(u.uFwd, cam.fwd); gl.uniform3fv(u.uUp, cam.up); gl.uniform3fv(u.uRight, cam.right)
    gl.uniform2f(u.uTan, cam.tanH, cam.tanV)
    gl.uniform1f(u.uTime, waveTime)
    gl.uniform1f(u.uViewH, canvas.height)
    // particles draw after tone mapping, so tint them to the scene's brightness directly
    const light = Math.min(1, 0.12 + 0.85 * L.daylight * (1 - 0.35 * season.overcast) + 0.25 * L.night * L.moonPow / 0.05)
    const warm = L.sunset * 0.25
    const tint = [light * (1 + warm * 0.3), light, light * (1 - warm * 0.4)]
    gl.uniform3fv(u.uCol, [0.72, 0.78, 0.86, 0.96, 0.98, 1, 1, 1, 1, 1, 1, 1].map((v, i) => v * tint[i % 3]))
    amounts.forEach((a, kind) => {
      const n = Math.round(PART_COUNTS[kind] * a)
      if (n < 1) return
      gl.uniform1i(u.uKind, kind)
      gl.drawArrays(gl.POINTS, 0, n)
    })
    gl.disable(gl.BLEND)
  }

  function start() { if (!raf) { last = now(); raf = requestAnimationFrame(frame) } }
  function stop() { cancelAnimationFrame(raf); raf = 0 }
  addEventListener('resize', resize)
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()))
  canvas.addEventListener('webglcontextrestored', () => location.reload())
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); document.documentElement.classList.add('webgl-unavailable') })

  return {
    ready: new Promise((res) => { onFirstFrame = res; start() }),
    setHours,
    setYear,
    get lighting() { return L },
    get breeze() { return breezeNow },
    worldAt, project, tap, drag, press,
    get camera() { return cam },
  }
}
