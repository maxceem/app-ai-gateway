/**
 * fal.
 *
 * Step 1a declares two of the hardest shapes:
 *
 * - `fal.run`: a plain call whose model id has slashes (`fal-ai/flux/dev`),
 *   so the path matches only models priced for it.
 * - `fal.queue`: a job. Submit gets an estimate. The client polls the gateway,
 *   which builds the upstream URLs from the signed job id and reads the billed
 *   units on the result call (plan D9, T15).
 *
 * The gateway path names the host: `run/...` goes to `fal.run`, `queue/...`
 * to `queue.fal.run`. The job lifecycle is in `../jobs/`.
 */
import { defineOperation, defineProvider } from "./operation.ts";

/** Billed units arrive in this header, on the response of a run or a queue result. */
const UNITS_HEADER = "x-fal-billable-units";

/** Input links fal fetches. Image and video models need them, so they are kept. */
const FETCH_KEPT = [
  { in: "body", field: "image_url" },
  { in: "body", field: "image_urls" },
  { in: "body", field: "mask_url" },
  { in: "body", field: "audio_url" },
  { in: "body", field: "video_url" },
] as const;

/**
 * Up front, and when the units header is missing, the units are worked out
 * from the request:
 *
 * - an image model bills each image by its megapixels, rounded up (T15), so
 *   a 1440 × 1440 image is two units. fal's size names are all one megapixel
 *   or less, and a size object's missing side is 512;
 * - a video model billed per second (`ltxv-13b`) bills the frames it asks for
 *   over its frame rate: 65 frames at 24 fps is 2.708 units (T15). Given only
 *   when the request names `num_frames` and the model is priced as a video
 *   (`kind: "video"`), and then it replaces the image estimate, being the
 *   later measure in the same unit. An image model keeps its megapixels,
 *   whatever video fields its request names;
 * - beside them, the image count, one video and one job, so a price per
 *   image, per video or per request (a customer's own, or ours for
 *   `ltx-video`) still bills.
 *
 * Every one stays an estimate, settled by the job's result.
 */
const estimate = [
  {
    measure: "image_megapixels",
    field: "num_images",
    default: 1,
    size: "image_size",
    sizes: {
      square_hd: [1024, 1024],
      square: [512, 512],
      portrait_4_3: [768, 1024],
      portrait_16_9: [576, 1024],
      landscape_4_3: [1024, 768],
      landscape_16_9: [1024, 576],
    },
    unit: "model_units",
  },
  { measure: "image_count", field: "num_images", default: 1, unit: "images" },
  { measure: "frames_seconds", field: "num_frames", fps: "frame_rate", defaultFps: 24, forKind: "video", unit: "model_units" },
  { measure: "one", unit: "videos" },
  { measure: "one", unit: "requests" },
] as const;

export const fal = defineProvider({
  type: "fal",
  label: "fal",
  hosts: { main: "fal.run", queue: "queue.fal.run" },
  auth: { header: "authorization", format: "Key {key}" },
  // Step 4 reviews the service modes with the full operation list.
  serviceModes: [],
  operations: [
    defineOperation({
      name: "fal.run",
      match: { method: "POST", path: "run/{model...}" },
      multiSegment: { model: "priced_models" },
      upstream: { path: "{model...}" },
      lifecycle: "call",
      transport: "http",
      model: { in: "path", part: "model" },
      outbound: { fetchKept: FETCH_KEPT },
      meter: { kind: "response_header", header: UNITS_HEADER, unit: "model_units", estimate },
    }),
    defineOperation({
      name: "fal.queue",
      match: { method: "POST", path: "queue/{model...}" },
      multiSegment: { model: "priced_models" },
      upstream: { host: "queue", path: "{model...}" },
      lifecycle: "job",
      transport: "http",
      model: { in: "path", part: "model" },
      outbound: { webhooks: [{ in: "query", field: "fal_webhook" }], fetchKept: FETCH_KEPT },
      meter: { kind: "response_header", header: UNITS_HEADER, unit: "model_units", estimate },
      job: {
        requestIdField: "request_id",
        status: { method: "GET", host: "queue", path: "{model_base}/requests/{request_id}/status" },
        result: { method: "GET", host: "queue", path: "{model_base}/requests/{request_id}" },
        cancel: { method: "PUT", host: "queue", path: "{model_base}/requests/{request_id}/cancel" },
        // fal says COMPLETED even for a job that failed: the result call tells (T15).
        doneWhen: { field: "status", values: ["COMPLETED"] },
        // A success, or a failure fal reports `0` billed units with (T15).
        finalStatuses: [200, 422],
        // Cancelled while still queued: nothing ran, and fal bills nothing (T15).
        cancelled: { status: 499, header: { name: "x-fal-error-type", value: "client_cancelled" } },
        links: { status: "status_url", result: "response_url", cancel: "cancel_url" },
        unitsHeader: UNITS_HEADER,
        // Image models answer `images`, video models `video` (T15's `ltx-video`).
        outputs: [
          { field: "images", unit: "images" },
          { field: "video", unit: "videos" },
          { field: "videos", unit: "videos" },
        ],
        // `?logs=1` asks fal for the runner's logs on a status poll.
        statusQuery: ["logs"],
        // Results go after an hour, large ones after 6 minutes (T15): check every minute, for an hour.
        checkEveryMs: 60_000,
        maxChecks: 60,
      },
    }),
  ],
});
