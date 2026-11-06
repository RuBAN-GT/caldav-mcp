import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { DAVClient } from "tsdav";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dav = vi.hoisted(() => ({
  login: vi.fn(),
  fetchCalendars: vi.fn(),
  fetchCalendarObjects: vi.fn<DAVClient["fetchCalendarObjects"]>(),
  createCalendarObject: vi.fn(),
  updateCalendarObject: vi.fn(),
  deleteCalendarObject: vi.fn(),
}));
vi.mock("tsdav", () => ({
  DAVClient: class {
    login = dav.login;
    fetchCalendars = dav.fetchCalendars;
    fetchCalendarObjects = dav.fetchCalendarObjects;
    createCalendarObject = dav.createCalendarObject;
    updateCalendarObject = dav.updateCalendarObject;
    deleteCalendarObject = dav.deleteCalendarObject;
  },
}));

import {
  createCalDavGateway,
  createCalendarId,
  createCalendarService,
  createMcpServer,
  createResourceId,
  iCloudProviderPolicy,
  loadConfig,
} from "../../src/index.js";

const url = "https://p01-caldav.icloud.com/123/calendars/shared/";
const otherUrl = "https://p01-caldav.icloud.com/123/calendars/private/";
const calendar = { url, displayName: "Shared" };
const otherCalendar = { url: otherUrl, displayName: "Shared" };
const id = createCalendarId(url);
const otherId = createCalendarId(otherUrl);
const resourceUrl = `${url}event.ics`;
const resourceId = createResourceId(url, resourceUrl);
const data = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Test//EN",
  "BEGIN:VEVENT",
  "UID:shared-uid",
  "DTSTAMP:20260901T000000Z",
  "DTSTART:20260912T100000Z",
  "DTEND:20260912T110000Z",
  "SUMMARY:Shared event",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");
const resource = {
  calendarId: id,
  resourceId,
  url: resourceUrl,
  data,
  etag: '"1"',
};
const config = loadConfig({
  CALDAV_USERNAME: "test@example.com",
  CALDAV_PASSWORD: "test",
  CALDAV_ALLOWED_CALENDAR_ID: id,
});
const range = { start: "2026-09-12T00:00:00Z", end: "2026-09-13T00:00:00Z" };
const eventInput = {
  summary: "New event",
  start: { date_time: "2026-09-12T10:00:00Z", timezone: "UTC" },
  end: { date_time: "2026-09-12T11:00:00Z", timezone: "UTC" },
};
const close: Array<() => Promise<void>> = [];
type ToolCase = [string, Record<string, unknown>];

const connect = async (settings = config) => {
  const gateway = createCalDavGateway(settings);
  const service = createCalendarService(
    gateway,
    iCloudProviderPolicy,
    () => "event",
  );
  const server = createMcpServer(service);
  const client = new Client({ name: "access-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
};

beforeEach(() => {
  vi.resetAllMocks();
  dav.login.mockResolvedValue(undefined);
  dav.fetchCalendars.mockResolvedValue([calendar, otherCalendar]);
  dav.fetchCalendarObjects.mockResolvedValue([
    { url: resourceUrl, data, etag: '"1"' },
  ]);
  for (const write of [
    dav.createCalendarObject,
    dav.updateCalendarObject,
    dav.deleteCalendarObject,
  ]) {
    write.mockResolvedValue(new Response(null, { status: 204 }));
  }
});

describe("multiple-calendar MCP access", () => {
  const multiConfig = loadConfig({
    CALDAV_USERNAME: "test@example.com",
    CALDAV_PASSWORD: "test",
    CALDAV_ALLOWED_CALENDAR_ID: `${id}, ${otherId}`,
  });

  it("lists only allowed collections and supports CRUD and UID lookups in both", async () => {
    const hiddenUrl = "https://p01-caldav.icloud.com/123/calendars/hidden/";
    dav.fetchCalendars.mockResolvedValue([
      calendar,
      otherCalendar,
      { url: hiddenUrl },
    ]);
    dav.fetchCalendarObjects.mockImplementation(({ calendar: target }) =>
      Promise.resolve([{ url: `${target.url}event.ics`, data, etag: '"1"' }]),
    );
    const client = await connect(multiConfig);
    const listing = await client.callTool({
      name: "list_calendars",
      arguments: {},
    });
    expect(listing.isError).not.toBe(true);
    expect(listing.structuredContent).toMatchObject({
      calendars: [{ calendar_id: id }, { calendar_id: otherId }],
    });
    expect(JSON.stringify(listing)).not.toContain(createCalendarId(hiddenUrl));
    for (const target of [url, otherUrl]) {
      const calendarId = createCalendarId(target);
      const eventId = createResourceId(target, `${target}event.ics`);
      for (const [name, args] of [
        ["list_events", { calendar_id: calendarId, ...range }],
        ["get_event", { resource_id: eventId }],
        ["get_event", { calendar_id: calendarId, uid: "shared-uid" }],
        ["create_event", { calendar_id: calendarId, ...eventInput }],
        [
          "update_event",
          {
            calendar_id: calendarId,
            uid: "shared-uid",
            patch: { summary: "Updated" },
          },
        ],
        ["delete_event", { resource_id: eventId }],
      ] satisfies ToolCase[]) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
      }
    }
    for (const [name, args] of [
      ["list_events", { calendar_id: createCalendarId(hiddenUrl), ...range }],
      [
        "get_event",
        { calendar_id: createCalendarId(hiddenUrl), uid: "shared-uid" },
      ],
      [
        "get_event",
        { resource_id: createResourceId(url, `${hiddenUrl}event.ics`) },
      ],
      [
        "update_event",
        {
          resource_id: createResourceId(hiddenUrl, `${hiddenUrl}event.ics`),
          patch: { summary: "Blocked" },
        },
      ],
      [
        "delete_event",
        { calendar_id: createCalendarId(hiddenUrl), uid: "shared-uid" },
      ],
      [
        "create_event",
        { calendar_id: createCalendarId(hiddenUrl), ...eventInput },
      ],
    ] satisfies ToolCase[]) {
      expect((await client.callTool({ name, arguments: args })).isError).toBe(
        true,
      );
    }
    expect(dav.createCalendarObject).toHaveBeenCalledTimes(2);
    expect(dav.updateCalendarObject).toHaveBeenCalledTimes(2);
    expect(dav.deleteCalendarObject).toHaveBeenCalledTimes(2);
    for (const [request] of dav.fetchCalendarObjects.mock.calls) {
      expect([url, otherUrl]).toContain(request.calendar.url);
    }
  });

  it.each([
    { calendars: [calendar] },
    { calendars: [calendar, { ...otherCalendar, url: `${otherUrl}changed/` }] },
    { calendars: [calendar, otherCalendar, otherCalendar] },
  ])(
    "blocks even the remaining calendar when any entry fails: %j",
    async ({ calendars }) => {
      const gateway = createCalDavGateway(multiConfig);
      await gateway.listCalendars();
      dav.fetchCalendars.mockResolvedValue(calendars);
      for (const operation of [
        () => gateway.listCalendars(),
        () => gateway.listResources(id),
        () => gateway.getResource(resourceId),
        () => gateway.createResource(id, "event.ics", data),
        () => gateway.updateResource(resource, data),
        () => gateway.deleteResource(resource),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          code: "CALENDAR_ACCESS_DENIED",
        });
      }
      expect(dav.fetchCalendarObjects).not.toHaveBeenCalled();
      expect(dav.createCalendarObject).not.toHaveBeenCalled();
      expect(dav.updateCalendarObject).not.toHaveBeenCalled();
      expect(dav.deleteCalendarObject).not.toHaveBeenCalled();
    },
  );
});
afterEach(async () => {
  for (const cleanup of close.splice(0)) await cleanup();
});

describe("single-calendar MCP access", () => {
  it("exposes only the exact collection, even when names collide or change", async () => {
    dav.fetchCalendars.mockResolvedValue([
      { ...calendar, displayName: "Renamed" },
      otherCalendar,
    ]);
    const client = await connect();
    const result = await client.callTool({
      name: "list_calendars",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      calendars: [{ calendar_id: id, display_name: "Renamed" }],
    });
    expect(JSON.stringify(result)).not.toContain(otherId);
  });

  it("preserves all six tools for the allowed calendar, including UID locators", async () => {
    const client = await connect();
    for (const [name, args] of [
      ["list_calendars", {}],
      ["list_events", { calendar_id: id, ...range }],
      ["get_event", { resource_id: resourceId, include_raw_ical: true }],
      ["get_event", { calendar_id: id, uid: "shared-uid" }],
      ["create_event", { calendar_id: id, ...eventInput }],
      [
        "update_event",
        { resource_id: resourceId, patch: { summary: "Updated" } },
      ],
      [
        "update_event",
        { calendar_id: id, uid: "shared-uid", patch: { summary: "Updated" } },
      ],
      ["delete_event", { resource_id: resourceId }],
      ["delete_event", { calendar_id: id, uid: "shared-uid" }],
    ] satisfies ToolCase[]) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
    }
    expect(dav.createCalendarObject).toHaveBeenCalledOnce();
    expect(dav.updateCalendarObject).toHaveBeenCalledTimes(2);
    expect(dav.deleteCalendarObject).toHaveBeenCalledTimes(2);
    for (const [request] of dav.fetchCalendarObjects.mock.calls) {
      expect(request.calendar.url).toBe(url);
    }
  });

  it("rejects other calendars through calendar IDs, UIDs, resource IDs and occurrences", async () => {
    const client = await connect();
    const otherResourceId = createResourceId(otherUrl, `${otherUrl}secret.ics`);
    for (const [name, args] of [
      ["list_events", { calendar_id: otherId, ...range }],
      ["create_event", { calendar_id: otherId, ...eventInput }],
      ...["get_event", "update_event", "delete_event"].flatMap<ToolCase>(
        (name) => [
          [
            name,
            {
              calendar_id: otherId,
              uid: "shared-uid",
              ...(name === "update_event"
                ? { patch: { summary: "Blocked" } }
                : {}),
            },
          ],
          [
            name,
            {
              resource_id: otherResourceId,
              ...(name === "update_event"
                ? { patch: { summary: "Blocked" } }
                : {}),
            },
          ],
        ],
      ),
      [
        "get_event",
        {
          resource_id: createResourceId(
            otherUrl,
            `${otherUrl}secret.ics`,
            "2026-09-12T10:00:00",
          ),
        },
      ],
    ] satisfies ToolCase[]) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).toBe(true);
      expect(JSON.stringify(result)).toContain("CALENDAR_ACCESS_DENIED");
    }
    expect(dav.fetchCalendarObjects).not.toHaveBeenCalled();
    expect(dav.createCalendarObject).not.toHaveBeenCalled();
    expect(dav.updateCalendarObject).not.toHaveBeenCalled();
    expect(dav.deleteCalendarObject).not.toHaveBeenCalled();
  });

  it.each([
    `${otherUrl}secret.ics`,
    "https://evil.example/secret.ics",
    `${url}../private/secret.ics`,
    `${url}%2e%2e/private/secret.ics`,
    `${url}%2e%2e%2fprivate%2fsecret.ics`,
    `${url}%252e%252e%252fsecret.ics`,
    `${url}nested/secret.ics`,
    `${url}..%5cprivate%5csecret.ics`,
    `${resourceUrl}?target=private`,
    `${resourceUrl}#private`,
  ])(
    "rejects a forged resource URL before any event request: %s",
    async (forgedUrl) => {
      const client = await connect();
      for (const name of ["get_event", "update_event", "delete_event"]) {
        const result = await client.callTool({
          name,
          arguments: {
            resource_id: createResourceId(url, forgedUrl),
            ...(name === "update_event"
              ? { patch: { summary: "Blocked" } }
              : {}),
          },
        });
        expect(result.isError).toBe(true);
      }
      expect(dav.fetchCalendarObjects).not.toHaveBeenCalled();
      expect(dav.updateCalendarObject).not.toHaveBeenCalled();
      expect(dav.deleteCalendarObject).not.toHaveBeenCalled();
    },
  );

  it.each([
    [],
    [otherCalendar],
    [{ ...calendar, url: `${url}new/` }],
    [calendar, calendar],
    [calendar, { ...calendar, url: url.slice(0, -1) }],
  ])(
    "fails closed on missing, changed or ambiguous collections: %j",
    async (...calendars) => {
      // Vitest spreads array cases into arguments.
      dav.fetchCalendars.mockResolvedValue(calendars);
      const client = await connect();
      for (const [name, args] of [
        ["list_calendars", {}],
        ["list_events", { calendar_id: id, ...range }],
        ["get_event", { resource_id: resourceId }],
        ["create_event", { calendar_id: id, ...eventInput }],
        [
          "update_event",
          { resource_id: resourceId, patch: { summary: "Blocked" } },
        ],
        ["delete_event", { calendar_id: id, uid: "shared-uid" }],
      ] satisfies ToolCase[]) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
      }
      expect(dav.fetchCalendarObjects).not.toHaveBeenCalled();
      expect(dav.createCalendarObject).not.toHaveBeenCalled();
    },
  );

  it("never falls back to a cached collection after removal or a discovery error", async () => {
    const gateway = createCalDavGateway(config);
    await gateway.listCalendars();
    dav.fetchCalendars.mockResolvedValue([]);
    await expect(gateway.listResources(id)).rejects.toMatchObject({
      code: "CALENDAR_ACCESS_DENIED",
    });
    dav.fetchCalendars.mockRejectedValue(new Error("offline"));
    await expect(gateway.getResource(resourceId)).rejects.toMatchObject({
      code: "CALDAV_UNAVAILABLE",
    });
    expect(dav.fetchCalendarObjects).not.toHaveBeenCalled();
  });

  it.each<{ operation: "updateResource" | "deleteResource" }>([
    { operation: "updateResource" },
    { operation: "deleteResource" },
  ])("reauthorizes %s immediately before writing", async ({ operation }) => {
    const gateway = createCalDavGateway(config);
    const read = await gateway.getResource(resourceId);
    dav.fetchCalendars.mockResolvedValue([otherCalendar]);
    await expect(gateway[operation](read, data)).rejects.toMatchObject({
      code: "CALENDAR_ACCESS_DENIED",
    });
    expect(dav.updateCalendarObject).not.toHaveBeenCalled();
    expect(dav.deleteCalendarObject).not.toHaveBeenCalled();
  });

  it("rejects forged write objects and server-returned URLs outside the collection", async () => {
    const gateway = createCalDavGateway(config);
    await expect(
      gateway.updateResource(
        { ...resource, url: `${otherUrl}secret.ics` },
        data,
      ),
    ).rejects.toThrow();
    await expect(
      gateway.deleteResource({ ...resource, calendarId: otherId }),
    ).rejects.toThrow();
    dav.fetchCalendarObjects.mockResolvedValue([
      { url: `${otherUrl}secret.ics`, data },
    ]);
    await expect(gateway.listResources(id)).rejects.toMatchObject({
      code: "CALENDAR_ACCESS_DENIED",
    });
    expect(dav.updateCalendarObject).not.toHaveBeenCalled();
    expect(dav.deleteCalendarObject).not.toHaveBeenCalled();
  });

  it.each([
    "../private/event.ics",
    "%2e%2e%2fprivate%2fevent.ics",
    "%252fsecret.ics",
    `${otherUrl}event.ics`,
  ])(
    "rejects create filenames that escape the collection: %s",
    async (filename) => {
      await expect(
        createCalDavGateway(config).createResource(id, filename, data),
      ).rejects.toThrow();
      expect(dav.createCalendarObject).not.toHaveBeenCalled();
    },
  );

  it("does not search another calendar when the UID is absent", async () => {
    dav.fetchCalendarObjects.mockResolvedValue([]);
    const client = await connect();
    const result = await client.callTool({
      name: "get_event",
      arguments: { calendar_id: id, uid: "private-uid" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("EVENT_NOT_FOUND");
    expect(dav.fetchCalendarObjects).toHaveBeenCalledOnce();
    expect(dav.fetchCalendarObjects.mock.calls[0]?.[0].calendar.url).toBe(url);
  });

  it("retains unrestricted listing when the variable is absent", async () => {
    const unrestricted = loadConfig({
      CALDAV_USERNAME: "test@example.com",
      CALDAV_PASSWORD: "test",
    });
    const gateway = createCalDavGateway(unrestricted);
    expect(await gateway.listCalendars()).toHaveLength(2);
    dav.fetchCalendarObjects.mockResolvedValue([]);
    await expect(gateway.listResources(otherId)).resolves.toEqual([]);
  });
});
