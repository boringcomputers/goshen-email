<script module lang="ts">
	import type { FallbackAvatarUniforms, Rgb } from '$lib/shared/fallback-avatar';

	const VERT_SRC = `
		attribute vec2 a_position;
		varying vec2 v_uv;

		void main() {
			v_uv = a_position * 0.5 + 0.5;
			gl_Position = vec4(a_position, 0.0, 1.0);
		}
	`;

	const FRAG_SRC = `
		precision mediump float;

		varying vec2 v_uv;
		uniform vec2 u_resolution;
		uniform vec3 u_color_a;
		uniform vec3 u_color_b;
		uniform vec3 u_color_c;
		uniform float u_time;
		uniform float u_seed;
		uniform float u_swirl;
		uniform float u_warp;
		uniform float u_grain;
		uniform float u_speed;

		float hash(vec2 p) {
			p = fract(p * vec2(123.34, 345.45));
			p += dot(p, p + 34.345 + u_seed);
			return fract(p.x * p.y);
		}

		void main() {
			vec2 uv = v_uv;
			vec2 p = (uv - 0.5) * 2.0;
			float radius = length(p);
			float angle = atan(p.y, p.x);
			float time = u_time * u_speed;

			angle += (1.0 - radius) * u_swirl;
			angle += 0.28 * sin(radius * 5.0 + time * 2.0 + u_seed * 6.28318);
			vec2 warped = vec2(cos(angle), sin(angle)) * radius;
			warped += u_warp * 0.16 * vec2(
				sin((uv.y + u_seed) * 9.0 + time),
				cos((uv.x - u_seed) * 8.0 - time)
			);

			float ribbon = 0.5 + 0.5 * sin((warped.x + warped.y) * 4.5 + time * 1.7);
			float cloud = 0.5 + 0.5 * cos(radius * 8.0 - angle * 2.0 + time);
			vec3 color = mix(u_color_a, u_color_b, ribbon);
			color = mix(color, u_color_c, cloud * 0.45);

			float vignette = smoothstep(1.08, 0.18, radius);
			float noise = (hash(gl_FragCoord.xy / max(u_resolution, vec2(1.0))) - 0.5) * u_grain;
			color = color * (0.82 + 0.22 * vignette) + noise;

			gl_FragColor = vec4(color, 1.0);
		}
	`;

	interface Renderer {
		canvas: HTMLCanvasElement;
		gl: WebGLRenderingContext;
		program: WebGLProgram;
		buffer: WebGLBuffer;
		locations: {
			position: number;
			resolution: WebGLUniformLocation | null;
			colorA: WebGLUniformLocation | null;
			colorB: WebGLUniformLocation | null;
			colorC: WebGLUniformLocation | null;
			time: WebGLUniformLocation | null;
			seed: WebGLUniformLocation | null;
			swirl: WebGLUniformLocation | null;
			warp: WebGLUniformLocation | null;
			grain: WebGLUniformLocation | null;
			speed: WebGLUniformLocation | null;
		};
	}

	let renderer: Renderer | null = null;

	function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
		const shader = gl.createShader(type);
		if (!shader) return null;
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			gl.deleteShader(shader);
			return null;
		}
		return shader;
	}

	function createRenderer(): Renderer | null {
		const canvas = document.createElement('canvas');
		const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
		if (!gl) return null;

		const vertex = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
		const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
		if (!vertex || !fragment) return null;

		const program = gl.createProgram();
		const buffer = gl.createBuffer();
		if (!program || !buffer) return null;

		gl.attachShader(program, vertex);
		gl.attachShader(program, fragment);
		gl.linkProgram(program);
		gl.deleteShader(vertex);
		gl.deleteShader(fragment);

		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			gl.deleteProgram(program);
			return null;
		}

		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(
			gl.ARRAY_BUFFER,
			new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
			gl.STATIC_DRAW
		);

		return {
			canvas,
			gl,
			program,
			buffer,
			locations: {
				position: gl.getAttribLocation(program, 'a_position'),
				resolution: gl.getUniformLocation(program, 'u_resolution'),
				colorA: gl.getUniformLocation(program, 'u_color_a'),
				colorB: gl.getUniformLocation(program, 'u_color_b'),
				colorC: gl.getUniformLocation(program, 'u_color_c'),
				time: gl.getUniformLocation(program, 'u_time'),
				seed: gl.getUniformLocation(program, 'u_seed'),
				swirl: gl.getUniformLocation(program, 'u_swirl'),
				warp: gl.getUniformLocation(program, 'u_warp'),
				grain: gl.getUniformLocation(program, 'u_grain'),
				speed: gl.getUniformLocation(program, 'u_speed')
			}
		};
	}

	function getRenderer(): Renderer | null {
		renderer ??= createRenderer();
		return renderer;
	}

	function rgbString(color: Rgb): string {
		return `rgb(${Math.round(color[0] * 255)} ${Math.round(color[1] * 255)} ${Math.round(color[2] * 255)})`;
	}

	function render2d(canvas: HTMLCanvasElement, uniforms: FallbackAvatarUniforms, width: number) {
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		canvas.width = width;
		canvas.height = width;
		const gradient = ctx.createRadialGradient(width * 0.28, width * 0.2, 0, width * 0.5, width * 0.55, width * 0.78);
		gradient.addColorStop(0, rgbString(uniforms.colorC));
		gradient.addColorStop(0.48, rgbString(uniforms.colorA));
		gradient.addColorStop(1, rgbString(uniforms.colorB));
		ctx.fillStyle = gradient;
		ctx.fillRect(0, 0, width, width);
	}

	function renderToCanvas(canvas: HTMLCanvasElement, uniforms: FallbackAvatarUniforms, time: number, size: number) {
		const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
		const width = Math.max(1, Math.round(size * dpr));
		const activeRenderer = getRenderer();
		if (!activeRenderer) {
			render2d(canvas, uniforms, width);
			return;
		}

		const { gl, locations, program, buffer, canvas: sourceCanvas } = activeRenderer;
		sourceCanvas.width = width;
		sourceCanvas.height = width;

		gl.viewport(0, 0, width, width);
		gl.useProgram(program);
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.enableVertexAttribArray(locations.position);
		gl.vertexAttribPointer(locations.position, 2, gl.FLOAT, false, 0, 0);
		gl.uniform2f(locations.resolution, width, width);
		gl.uniform3fv(locations.colorA, uniforms.colorA);
		gl.uniform3fv(locations.colorB, uniforms.colorB);
		gl.uniform3fv(locations.colorC, uniforms.colorC);
		gl.uniform1f(locations.time, time);
		gl.uniform1f(locations.seed, uniforms.seed);
		gl.uniform1f(locations.swirl, uniforms.swirl);
		gl.uniform1f(locations.warp, uniforms.warp);
		gl.uniform1f(locations.grain, uniforms.grain);
		gl.uniform1f(locations.speed, uniforms.speed);
		gl.drawArrays(gl.TRIANGLES, 0, 6);

		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		canvas.width = width;
		canvas.height = width;
		ctx.clearRect(0, 0, width, width);
		ctx.drawImage(sourceCanvas, 0, 0, width, width);
	}

	function startRenderLoop(
		canvas: HTMLCanvasElement,
		uniforms: FallbackAvatarUniforms,
		size: number,
		animated: boolean
	) {
		let frame = 0;
		let stopped = false;

		const draw = (now: number) => {
			renderToCanvas(canvas, uniforms, now / 1000, size);
			if (animated && !stopped) {
				frame = requestAnimationFrame(draw);
			}
		};

		draw(0);

		return () => {
			stopped = true;
			if (frame) cancelAnimationFrame(frame);
		};
	}
</script>

<script lang="ts">
	import { browser } from '$app/environment';
	import type { ClassValue } from 'svelte/elements';
	import { cn } from '$lib/utils';
	import { computeFallbackAvatarUniforms } from '$lib/shared/fallback-avatar';

	interface Props {
		name?: string | null;
		imageUrl?: string | null;
		alt?: string;
		size?: number;
		animated?: boolean;
		class?: ClassValue;
	}

	let {
		name = 'Avatar',
		imageUrl = null,
		alt = '',
		size = 32,
		animated = true,
		class: className
	}: Props = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	let hovering = $state(false);

	const avatarName = $derived(name?.trim() || 'Avatar');
	const pixelSize = $derived(Math.max(1, Math.round(size)));
	const uniforms = $derived(computeFallbackAvatarUniforms(avatarName));
	const resolvedImageUrl = $derived(imageUrl?.trim() || null);
	const shouldAnimate = $derived(animated && hovering);

	$effect(() => {
		if (!browser || resolvedImageUrl || !canvas) return;
		return startRenderLoop(canvas, uniforms, pixelSize, shouldAnimate);
	});
</script>

{#if resolvedImageUrl}
	<img
		src={resolvedImageUrl}
		{alt}
		class={cn('block rounded-full object-cover', className)}
		style:width={`${pixelSize}px`}
		style:height={`${pixelSize}px`}
	/>
{:else}
	<canvas
		bind:this={canvas}
		width={pixelSize}
		height={pixelSize}
		class={cn('block rounded-full bg-[var(--muted)]', className)}
		style:width={`${pixelSize}px`}
		style:height={`${pixelSize}px`}
		aria-label={`Fallback avatar for ${avatarName}`}
		onpointerenter={() => (hovering = true)}
		onpointerleave={() => (hovering = false)}
	></canvas>
{/if}
