import { expect, test } from "bun:test";
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";

import type { AiConfig } from "../src/stores/use-config-store";
import type { ReferenceImage } from "../src/types/image";

Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const { createVideoGenerationTask, pollVideoGenerationTask } = await import("../src/services/api/video");
const { defaultConfig } = await import("../src/stores/use-config-store");

function configFor(model: string): AiConfig {
    return {
        ...defaultConfig,
        baseUrl: "https://example.test/v1",
        apiKey: "test-key",
        channels: [{ id: "test", name: "test", baseUrl: "https://example.test/v1", apiKey: "test-key", apiFormat: "openai", models: [{ name: model, capability: "video" }] }],
        model: `test::${model}`,
        videoModel: `test::${model}`,
        videoSeconds: "6",
        size: "16:9",
        vquality: "720",
    };
}

const image: ReferenceImage = { id: "image-1", name: "image.png", type: "image/png", dataUrl: "data:image/png;base64,aW1n" };

async function withAdapter(adapter: AxiosAdapter, run: () => Promise<void>) {
    const previous = axios.defaults.adapter;
    axios.defaults.adapter = adapter;
    try {
        await run();
    } finally {
        axios.defaults.adapter = previous;
    }
}

function response(config: InternalAxiosRequestConfig, data: unknown) {
    return { data, status: 200, statusText: "OK", headers: {}, config };
}

test("Grok image-to-video sends JSON and accepts xAI task and result fields", async () => {
    const requests: InternalAxiosRequestConfig[] = [];
    await withAdapter(async (config) => {
        requests.push(config);
        if (config.method === "post") return response(config, { request_id: "req-1" });
        if (config.url?.endsWith("/videos/req-1")) return response(config, { status: "done", video: { url: "https://example.test/video.mp4" } });
        return response(config, new Blob(["video"], { type: "video/mp4" }));
    }, async () => {
        const config = configFor("grok-imagine-video");
        const task = await createVideoGenerationTask(config, "Animate", [image]);
        expect(task.id).toBe("req-1");
        const state = await pollVideoGenerationTask(config, task);
        expect(state.status).toBe("completed");
        expect(requests[0].url).toBe("https://example.test/v1/videos/generations");
        expect(requests[0].headers.get("Content-Type")).toBe("application/json");
        expect(JSON.parse(requests[0].data as string)).toEqual({
            model: "grok-imagine-video",
            prompt: "Animate",
            duration: 6,
            aspect_ratio: "16:9",
            resolution: "720p",
            generate_audio: true,
            image: { url: image.dataUrl },
        });
        expect(requests[1].url).toBe("https://example.test/v1/videos/req-1");
    });
});

test("Grok text-to-video omits the image field", async () => {
    await withAdapter(async (config) => {
        expect(JSON.parse(config.data as string).image).toBeUndefined();
        return response(config, { request_id: "req-2" });
    }, async () => {
        expect((await createVideoGenerationTask(configFor("grok-imagine-video"), "Animate")).id).toBe("req-2");
    });
});

test("Grok 1.5 image-to-video uses the same JSON request", async () => {
    await withAdapter(async (config) => {
        const body = JSON.parse(config.data as string);
        expect(body.model).toBe("grok-imagine-video-1.5");
        expect(body.image.url).toBe(image.dataUrl);
        return response(config, { request_id: "req-1.5" });
    }, async () => {
        expect((await createVideoGenerationTask(configFor("grok-imagine-video-1.5"), "Animate", [image])).id).toBe("req-1.5");
    });
});

test("classic Grok rejects pinned first and last frames before sending a request", async () => {
    let requests = 0;
    await withAdapter(async (config) => {
        requests += 1;
        return response(config, { request_id: "unexpected" });
    }, async () => {
        await expect(createVideoGenerationTask(configFor("grok-imagine-video"), "Animate", [image, image])).rejects.toThrow("固定尾帧需要");
    });
    expect(requests).toBe(0);
});

test("classic Grok reference mode accepts seven reference images", async () => {
    await withAdapter(async (config) => {
        const body = JSON.parse(config.data as string);
        expect(body.reference_images).toHaveLength(7);
        expect(body.image).toBeUndefined();
        return response(config, { request_id: "reference-7" });
    }, async () => {
        const config = { ...configFor("grok-imagine-video"), videoMode: "reference" };
        expect((await createVideoGenerationTask(config, "Animate", Array.from({ length: 7 }, (_, index) => ({ ...image, id: String(index) })))).id).toBe("reference-7");
    });
});

test("Grok 1.5 combines pinned frames, keyframes, references and preset voices", async () => {
    await withAdapter(async (config) => {
        const body = JSON.parse(config.data as string);
        expect(body.image.url).toBe(image.dataUrl);
        expect(body.last_frame.url).toBe(image.dataUrl);
        expect(body.keyframes).toEqual([{ image: { url: image.dataUrl }, timestamp_s: 2 }]);
        expect(body.reference_images).toHaveLength(1);
        expect(body.reference_audios).toEqual([{ voice_id: "eve" }, { voice_id: "leo" }]);
        expect(body.generate_audio).toBe(false);
        return response(config, { request_id: "combined" });
    }, async () => {
        const config = { ...configFor("grok-imagine-video-1.5"), videoMode: "reference", videoPinFirst: "true", videoPinLast: "true", videoKeyframeTimes: "2", videoVoiceIds: "eve, leo", videoGenerateAudio: "false" };
        expect((await createVideoGenerationTask(config, "Animate", Array.from({ length: 4 }, (_, index) => ({ ...image, id: String(index) })))).id).toBe("combined");
    });
});

test("Grok 1.5 permits image-only 1080p and an omitted prompt", async () => {
    await withAdapter(async (request) => {
        const body = JSON.parse(request.data as string);
        expect(body.prompt).toBe("");
        expect(body.image.url).toBe(image.dataUrl);
        expect(body.resolution).toBe("1080p");
        return response(request, { request_id: "image-only" });
    }, async () => {
        expect((await createVideoGenerationTask({ ...configFor("grok-imagine-video-1.5"), vquality: "1080" }, "", [image])).id).toBe("image-only");
    });
});

test("Grok refuses 1080p reference mode and missing pinned frames", async () => {
    let requests = 0;
    await withAdapter(async (request) => {
        requests += 1;
        return response(request, { request_id: "unexpected" });
    }, async () => {
        await expect(createVideoGenerationTask({ ...configFor("grok-imagine-video-1.5"), videoMode: "reference", vquality: "1080" }, "Animate", [image])).rejects.toThrow("720p");
        await expect(createVideoGenerationTask({ ...configFor("grok-imagine-video-1.5"), videoMode: "reference", videoPinFirst: "true", videoPinLast: "true" }, "Animate", [image])).rejects.toThrow("固定尾帧");
    });
    expect(requests).toBe(0);
});

test("Grok pending and expired statuses stay distinct", async () => {
    const task = { id: "req-status", provider: "openai" as const, model: "test::grok-imagine-video" };
    for (const status of ["pending", "expired"]) {
        await withAdapter(async (request) => response(request, { status }), async () => {
            const state = await pollVideoGenerationTask(configFor("grok-imagine-video"), task);
            expect(state.status).toBe(status === "pending" ? "pending" : "failed");
        });
    }
});

test("Grok edit and extension use their dedicated JSON endpoints", async () => {
    const video = { id: "source", name: "source.mp4", type: "video/mp4", url: "https://example.test/source.mp4" };
    for (const mode of ["edit", "extend"]) {
        await withAdapter(async (request) => {
            expect(request.url).toBe(`https://example.test/v1/videos/${mode === "edit" ? "edits" : "extensions"}`);
            const body = JSON.parse(request.data as string);
            expect(body.video.url).toBe(video.url);
            expect(body.duration).toBe(mode === "extend" ? 6 : undefined);
            return response(request, { request_id: mode });
        }, async () => {
            expect((await createVideoGenerationTask({ ...configFor("grok-imagine-video"), videoMode: mode }, "Animate", [], { videos: [video] })).id).toBe(mode);
        });
    }
});

test("Grok rejects invalid 1.5 keyframes and extension duration before submission", async () => {
    let requests = 0;
    await withAdapter(async (config) => {
        requests += 1;
        return response(config, { request_id: "unexpected" });
    }, async () => {
        await expect(createVideoGenerationTask({ ...configFor("grok-imagine-video-1.5"), videoMode: "reference", videoKeyframeTimes: "2.1" }, "Animate", [image])).rejects.toThrow("关键帧");
        await expect(createVideoGenerationTask({ ...configFor("grok-imagine-video"), videoMode: "extend", videoSeconds: "11" }, "Animate", [], { videos: [{ id: "source", name: "source.mp4", type: "video/mp4", url: "https://example.test/source.mp4" }] })).rejects.toThrow("2–10 秒");
    });
    expect(requests).toBe(0);
});

test("other OpenAI-compatible video models keep multipart requests", async () => {
    await withAdapter(async (config) => {
        expect(config.data).toBeInstanceOf(FormData);
        expect((config.data as FormData).get("model")).toBe("sora-2");
        return response(config, { id: "req-3" });
    }, async () => {
        expect((await createVideoGenerationTask(configFor("sora-2"), "Animate")).id).toBe("req-3");
    });
});

test("video requests use the selected channel URL and preserve other channels", async () => {
    const config = configFor("grok-imagine-video-1.5");
    config.channels.push({ id: "other", name: "other", baseUrl: "https://other.test/api/v1", apiKey: "other-key", apiFormat: "openai", models: [{ name: "sora-2", capability: "video" }] });
    await withAdapter(async (request) => {
        expect(request.url).toBe("https://other.test/api/v1/videos");
        expect(request.headers.get("Authorization")).toBe("Bearer other-key");
        expect(request.data).toBeInstanceOf(FormData);
        return response(request, { id: "other-job" });
    }, async () => {
        expect((await createVideoGenerationTask({ ...config, model: "other::sora-2", videoModel: "other::sora-2" }, "Animate")).id).toBe("other-job");
    });
});
