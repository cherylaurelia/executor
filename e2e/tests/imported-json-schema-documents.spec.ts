import { expect, layer } from "@effect/vitest";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";

/**
 * Every app evaluation builds each imported schema again, so building one must stay a single
 * pass over its document. `shared` reaches its leaf through 2^30 paths: a check that revisits
 * shared parts cannot finish within the scenario deadline. `nested` is 20,000 levels deep: a
 * recursive check overflows the stack and the evaluation fails. Neither schema is parsed, so
 * only construction is exercised; `source.route` shows a shared definition still validates.
 * `paint` nests imported schemas inside framework schemas: its listed input describes each one
 * where it sits, except a document with references, which reads differently away from its root.
 */
const color = { type: "string", enum: ["red", "blue"] };
const source = `
import { array, defineApp, dynamicRouter, jsonSchema, object, query, router } from "apps";
const address = { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false };
const route = { type: "object", properties: { home: address, work: address }, required: ["home", "work"], additionalProperties: false };
let shared = { type: "string" };
for (let level = 0; level < 30; level++) shared = { anyOf: [shared, shared] };
let nested = { type: "string" };
for (let level = 0; level < 20000; level++) nested = { not: nested };
const color = ${JSON.stringify(color)};
const linked = { $defs: { color }, type: "object", properties: { color: { $ref: "#/$defs/color" } } };
export default defineApp({}, {
  tools: router({
    paint: query({
      input: object({
        color: jsonSchema(color),
        palette: array(jsonSchema(color)),
        accent: jsonSchema(color).optional(),
        linked: jsonSchema(linked).optional(),
      }),
    }, async (_, input) => JSON.stringify(input)),
    source: dynamicRouter({
      list: async () => [{ name: "route", description: "Echo a route", inputSchema: route, readOnly: true }],
      resolve: async (name) => {
        jsonSchema({ type: "object", properties: { value: shared } });
        jsonSchema(nested);
        return name === "route" ? query({ input: jsonSchema(route) }, async (_, input) => JSON.stringify(input)) : undefined;
      },
    }),
  }),
});
`;

layer(HostedLive, { excludeTestServices: true })("Imported JSON Schemas", (it) => {
  it.effect(scenarios.importedJsonSchemaDocuments.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Imported schemas ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const path = `${prefix}/${(yield* body(App, deployed)).id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const call = (input: unknown) =>
          api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool: "source.route",
            input,
          });
        const input = { home: { city: "Springfield" }, work: { city: "Shelbyville" } };
        // Two calls: each evaluates the app and builds both schemas again.
        for (const _ of [1, 2]) {
          const result = yield* call(input);
          expect(result.status, JSON.stringify(result.body)).toBe(200);
          expect(JSON.parse(yield* body(Schema.String, result))).toEqual(input);
        }
        const invalid = yield* call({ home: { city: "Springfield" }, work: {} });
        expect(invalid.status, JSON.stringify(invalid.body)).not.toBe(200);
        const catalog = yield* body(
          Schema.Struct({
            items: Schema.Array(
              Schema.Struct({
                name: Schema.String,
                inputSchema: Schema.Struct({
                  properties: Schema.Unknown,
                  required: Schema.Array(Schema.String),
                }),
              }),
            ),
          }),
          yield* api.request(actors.owner, "GET", `${path}/tools`),
        );
        const listed = catalog.items.find((tool) => tool.name === "paint")?.inputSchema;
        expect(listed?.properties).toEqual({
          color,
          palette: { type: "array", items: color },
          accent: { anyOf: [color, { type: "null" }] },
          linked: { anyOf: [{}, { type: "null" }] },
        });
        expect(listed?.required).toEqual(["color", "palette"]);
        const paint = (input: unknown) =>
          api.request(actors.owner, "POST", `${path}/tools/call`, { tool: "paint", input });
        expect((yield* paint({ color: "red", palette: ["blue"] })).status).toBe(200);
        for (const input of [
          { color: "green", palette: [] },
          { color: "red", palette: ["green"] },
          { color: "red", palette: [], accent: "green" },
          { color: "red", palette: [], linked: { color: "green" } },
        ]) {
          const rejected = yield* paint(input);
          expect(rejected.status, JSON.stringify(rejected.body)).not.toBe(200);
        }
      }),
    ),
  );
});
