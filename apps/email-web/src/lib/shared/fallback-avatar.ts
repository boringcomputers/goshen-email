export type Rgb = readonly [number, number, number];

export interface FallbackAvatarUniforms {
	colorA: Rgb;
	colorB: Rgb;
	colorC: Rgb;
	seed: number;
	swirl: number;
	warp: number;
	grain: number;
	speed: number;
}

const UINT32_MAX = 0xffffffff;

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function roundChannel(value: number): number {
	return Math.round(clamp01(value) * 1000) / 1000;
}

export function hashString(input: string): [number, number] {
	let h1 = 0xdeadbeef ^ input.length;
	let h2 = 0x41c6ce57 ^ input.length;

	for (let i = 0; i < input.length; i += 1) {
		const char = input.charCodeAt(i);
		h1 = Math.imul(h1 ^ char, 2654435761);
		h2 = Math.imul(h2 ^ char, 1597334677);
	}

	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
		Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
		Math.imul(h1 ^ (h1 >>> 13), 3266489909);

	return [h1 >>> 0, h2 >>> 0];
}

export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state += 0x6d2b79f5;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function deriveHue(hash: readonly [number, number]): number {
	return (hash[0] + hash[1] * 0.38196601125) % 360;
}

export function oklchToRgb(lightness: number, chroma: number, hue: number): Rgb {
	const hueRadians = (hue * Math.PI) / 180;
	const a = chroma * Math.cos(hueRadians);
	const b = chroma * Math.sin(hueRadians);

	const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
	const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
	const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;

	const l = lPrime * lPrime * lPrime;
	const m = mPrime * mPrime * mPrime;
	const s = sPrime * sPrime * sPrime;

	const linearR = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	const linearG = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	const linearB = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

	const toSrgb = (channel: number) =>
		channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;

	return [roundChannel(toSrgb(linearR)), roundChannel(toSrgb(linearG)), roundChannel(toSrgb(linearB))];
}

export function getColors(hash: readonly [number, number]): [Rgb, Rgb, Rgb] {
	const hue = deriveHue(hash);

	return [
		oklchToRgb(0.72, 0.19, hue),
		oklchToRgb(0.68, 0.22, hue + 72 + (hash[0] % 32)),
		oklchToRgb(0.82, 0.13, hue + 196 + (hash[1] % 44))
	];
}

export function computeFallbackAvatarUniforms(name: string): FallbackAvatarUniforms {
	const normalizedName = name.trim().toLocaleLowerCase() || 'anonymous';
	const hash = hashString(normalizedName);
	const random = mulberry32(hash[0] ^ hash[1]);
	const [colorA, colorB, colorC] = getColors(hash);

	return {
		colorA,
		colorB,
		colorC,
		seed: Math.round((hash[0] / UINT32_MAX) * 1000000) / 1000000,
		swirl: Math.round((0.65 + random() * 0.7) * 1000000) / 1000000,
		warp: Math.round((0.25 + random() * 0.45) * 1000000) / 1000000,
		grain: Math.round((0.025 + random() * 0.045) * 1000000) / 1000000,
		speed: Math.round((0.22 + random() * 0.34) * 1000000) / 1000000
	};
}
