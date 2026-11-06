import { DAVClient, type DAVCalendar, type DAVCalendarObject } from "tsdav";

import type { AppConfig } from "../config.js";
import { createAppError, isAppError } from "../errors.js";
import {
  createCalendarId,
  createResourceId,
  readCalendarId,
  readResourceId,
} from "./resource-handle.js";
import type {
  CalDavGateway,
  CalendarInfo,
  CalendarRange,
  CalendarResource,
} from "./types.js";

const calendarDiscoveryTtlMilliseconds = 5 * 60 * 1_000;

type CalendarSnapshot = {
  readonly calendars: readonly DAVCalendar[];
  readonly discoveredAt: number;
};

const calendarUrlsEqual = (left: string, right: string): boolean => {
  const withoutTrailingSlash = (value: string): string =>
    value.endsWith("/") ? value.slice(0, -1) : value;
  return withoutTrailingSlash(left) === withoutTrailingSlash(right);
};

const findCalendar = (
  calendars: readonly DAVCalendar[],
  calendarUrl: string,
): DAVCalendar | undefined =>
  calendars.find((calendar) => calendarUrlsEqual(calendar.url, calendarUrl));

const createTimedFetch =
  (timeoutMilliseconds: number): typeof fetch =>
  (input, init) => {
    const signals = [AbortSignal.timeout(timeoutMilliseconds)];
    if (init?.signal instanceof AbortSignal) {
      signals.push(init.signal);
    }
    return fetch(input, {
      ...init,
      signal: AbortSignal.any(signals),
    });
  };

const mapTransportError = (cause: unknown): Error => {
  if (isAppError(cause)) {
    return cause;
  }
  const message = cause instanceof Error ? cause.message.toLowerCase() : "";
  if (message.includes("401") || message.includes("unauthorized")) {
    return createAppError({
      code: "AUTHENTICATION_FAILED",
      message: "The CalDAV server rejected the configured credentials",
      cause,
    });
  }
  return createAppError({
    code: "CALDAV_UNAVAILABLE",
    message: "The CalDAV server is unavailable",
    retryable: true,
    cause,
  });
};

const protect = async <Result>(
  operation: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch (cause) {
    throw mapTransportError(cause);
  }
};

const assertSuccessfulResponse = (response: Response): void => {
  if (response.ok) {
    return;
  }
  if (response.status === 401 || response.status === 403) {
    throw createAppError({
      code: "AUTHENTICATION_FAILED",
      message: "The CalDAV server rejected the configured credentials",
    });
  }
  if (response.status === 404) {
    throw createAppError({
      code: "EVENT_NOT_FOUND",
      message: "The calendar event no longer exists",
    });
  }
  if (response.status === 409 || response.status === 412) {
    throw createAppError({
      code: "ETAG_CONFLICT",
      message: "The calendar event changed on the server",
    });
  }
  throw createAppError({
    code: "WRITE_RESULT_UNKNOWN",
    message: `The CalDAV server rejected the write with status ${String(response.status)}`,
    retryable: response.status >= 500,
  });
};

const calendarDisplayName = (calendar: DAVCalendar): string => {
  const displayName: unknown = calendar.displayName;
  return typeof displayName === "string" && displayName !== ""
    ? displayName
    : "Calendar";
};

const calendarDescription = (calendar: DAVCalendar): string | null => {
  const description: unknown = calendar.description;
  return typeof description === "string" && description !== ""
    ? description
    : null;
};

const calendarTimezone = (calendar: DAVCalendar): string | null => {
  const timezone: unknown = calendar.timezone;
  return typeof timezone === "string" && timezone !== "" ? timezone : null;
};

const resourceData = (resource: DAVCalendarObject): string => {
  const data: unknown = resource.data;
  if (typeof data !== "string") {
    throw createAppError({
      code: "INVALID_ICALENDAR",
      message: "The CalDAV resource does not contain calendar data",
    });
  }
  if (Buffer.byteLength(data, "utf8") > 5 * 1_024 * 1_024) {
    throw createAppError({
      code: "RESOURCE_TOO_LARGE",
      message: "The calendar resource exceeds the 5 MiB limit",
    });
  }
  return data;
};

const toResource = (
  calendar: DAVCalendar,
  resource: DAVCalendarObject,
): CalendarResource => ({
  calendarId: createCalendarId(calendar.url),
  resourceId: createResourceId(calendar.url, resource.url),
  url: resource.url,
  etag: resource.etag ?? null,
  data: resourceData(resource),
});

export const createCalDavGateway = (config: AppConfig): CalDavGateway => {
  const client = new DAVClient({
    serverUrl: config.url,
    credentials: {
      username: config.username,
      password: config.password,
    },
    authMethod: "Basic",
    defaultAccountType: "caldav",
    fetch: createTimedFetch(config.requestTimeoutMs),
  });
  let login: Promise<void> | undefined;
  let calendarSnapshot: CalendarSnapshot | undefined;
  let calendarDiscovery: Promise<CalendarSnapshot> | undefined;

  const ensureLogin = async (): Promise<void> => {
    login ??= client.login({ loadCollections: false, loadObjects: false });
    try {
      await login;
    } catch (cause) {
      login = undefined;
      throw cause;
    }
  };

  const discoverCalendars = async (): Promise<CalendarSnapshot> => {
    calendarDiscovery ??= (async () => {
      await ensureLogin();
      const calendars = await client.fetchCalendars();
      const snapshot = {
        calendars,
        discoveredAt: Date.now(),
      } satisfies CalendarSnapshot;
      calendarSnapshot = snapshot;
      return snapshot;
    })();
    const currentDiscovery = calendarDiscovery;
    try {
      return await currentDiscovery;
    } finally {
      if (calendarDiscovery === currentDiscovery) {
        calendarDiscovery = undefined;
      }
    }
  };

  const accessDenied = (): Error =>
    createAppError({
      code: "CALENDAR_ACCESS_DENIED",
      message:
        "Calendar access is restricted and the target cannot be authorized",
    });

  // IDs identify collection URLs, never display names. Do not fall back to a
  // cached collection (or another collection) when discovery fails or changes.
  const allowedCalendar = (snapshot: CalendarSnapshot): DAVCalendar => {
    const { calendarUrl } = readCalendarId(config.allowedCalendarId ?? "");
    const matches = snapshot.calendars.filter((calendar) =>
      calendarUrlsEqual(calendar.url, calendarUrl),
    );
    const calendar = matches[0];
    if (
      matches.length !== 1 ||
      calendar === undefined ||
      createCalendarId(calendar.url) !== config.allowedCalendarId
    ) {
      throw accessDenied();
    }
    return calendar;
  };

  const assertResourceUrl = (
    calendar: DAVCalendar,
    resourceUrl: string,
  ): void => {
    if (config.allowedCalendarId === undefined) {
      return;
    }
    const collection = new URL(calendar.url);
    const resource = new URL(resourceUrl);
    const path = collection.pathname.endsWith("/")
      ? collection.pathname
      : `${collection.pathname}/`;
    const filename = resource.pathname.slice(path.length);
    let decoded: string;
    try {
      decoded = decodeURIComponent(filename);
    } catch {
      throw accessDenied();
    }
    // Only canonical, immediate collection members are usable. In particular,
    // encoded separators and nested/encoded traversal must not reach CalDAV.
    if (
      resource.href !== resourceUrl ||
      resource.origin !== collection.origin ||
      resource.username !== "" ||
      resource.password !== "" ||
      resource.search !== "" ||
      resource.hash !== "" ||
      !resource.pathname.startsWith(path) ||
      decoded === "" ||
      decoded === "." ||
      decoded === ".." ||
      /[\\/%]/.test(decoded)
    ) {
      throw accessDenied();
    }
  };

  const resolveCalendar = async (calendarId: string): Promise<DAVCalendar> => {
    if (config.allowedCalendarId !== undefined) {
      if (calendarId !== config.allowedCalendarId) {
        throw accessDenied();
      }
      return allowedCalendar(await discoverCalendars());
    }
    const handle = readCalendarId(calendarId);
    const cachedSnapshot = calendarSnapshot;
    const cachedCalendar =
      cachedSnapshot === undefined ||
      Date.now() - cachedSnapshot.discoveredAt >
        calendarDiscoveryTtlMilliseconds
        ? undefined
        : findCalendar(cachedSnapshot.calendars, handle.calendarUrl);
    if (cachedCalendar !== undefined) {
      return cachedCalendar;
    }

    const previousSnapshot = calendarSnapshot;
    const discoveredSnapshot = await discoverCalendars();
    const calendar = findCalendar(
      discoveredSnapshot.calendars,
      handle.calendarUrl,
    );
    if (calendar === undefined) {
      const wasPreviouslyDiscovered =
        previousSnapshot !== undefined &&
        findCalendar(previousSnapshot.calendars, handle.calendarUrl) !==
          undefined;
      throw createAppError({
        code: "CALENDAR_NOT_FOUND",
        message: "The calendar is not available for the configured account",
        retryable: wasPreviouslyDiscovered,
      });
    }
    return calendar;
  };

  const listCalendars = (): Promise<readonly CalendarInfo[]> =>
    protect(async () => {
      const snapshot = await discoverCalendars();
      const calendars =
        config.allowedCalendarId === undefined
          ? snapshot.calendars
          : [allowedCalendar(snapshot)];
      return calendars.map((calendar) => ({
        calendarId: createCalendarId(calendar.url),
        displayName: calendarDisplayName(calendar),
        description: calendarDescription(calendar),
        timezone: calendarTimezone(calendar),
        writable: null,
      }));
    });

  const fetchResources = async (
    calendar: DAVCalendar,
    range?: CalendarRange,
    objectUrls?: readonly string[],
  ): Promise<readonly CalendarResource[]> => {
    const resources = await client.fetchCalendarObjects({
      calendar,
      ...(range === undefined ? {} : { timeRange: range }),
      ...(objectUrls === undefined ? {} : { objectUrls: [...objectUrls] }),
      expand: false,
      useMultiGet: true,
    });
    return resources.map((resource) => {
      assertResourceUrl(calendar, resource.url);
      return toResource(calendar, resource);
    });
  };

  const listResources = (
    calendarId: string,
    range?: CalendarRange,
  ): Promise<readonly CalendarResource[]> =>
    protect(async () => {
      const calendar = await resolveCalendar(calendarId);
      return fetchResources(calendar, range);
    });

  const getResource = (resourceId: string): Promise<CalendarResource> =>
    protect(async () => {
      const handle = readResourceId(resourceId);
      const calendar = await resolveCalendar(
        createCalendarId(handle.calendarUrl),
      );
      assertResourceUrl(calendar, handle.resourceUrl);
      let resources: readonly CalendarResource[];
      try {
        resources = await fetchResources(calendar, undefined, [
          handle.resourceUrl,
        ]);
      } catch (cause) {
        if (isAppError(cause) && cause.code === "CALENDAR_ACCESS_DENIED") {
          throw cause;
        }
        resources = await fetchResources(calendar);
      }
      const resource = resources.find(
        (candidate) => candidate.url === handle.resourceUrl,
      );
      if (resource === undefined) {
        throw createAppError({
          code: "EVENT_NOT_FOUND",
          message: "The calendar event was not found",
        });
      }
      return resource;
    });

  const createResource = (
    calendarId: string,
    filename: string,
    data: string,
  ): Promise<CalendarResource> =>
    protect(async () => {
      const calendar = await resolveCalendar(calendarId);
      if (
        config.allowedCalendarId !== undefined &&
        (filename === "" || /[\\/%?#]/.test(decodeURIComponent(filename)))
      ) {
        throw accessDenied();
      }
      const resourceUrl = new URL(filename, calendar.url).href;
      assertResourceUrl(calendar, resourceUrl);
      const response = await client.createCalendarObject({
        calendar,
        filename,
        iCalString: data,
      });
      assertSuccessfulResponse(response);
      const resources = await fetchResources(calendar, undefined, [
        resourceUrl,
      ]);
      const resource = resources[0];
      if (resource === undefined) {
        throw createAppError({
          code: "WRITE_RESULT_UNKNOWN",
          message: "The event was written but could not be read back",
        });
      }
      return resource;
    });

  const updateResource = (
    resource: CalendarResource,
    data: string,
  ): Promise<CalendarResource> =>
    protect(async () => {
      await authorizeWrite(resource);
      const response = await client.updateCalendarObject({
        calendarObject: {
          url: resource.url,
          data,
          ...(resource.etag === null ? {} : { etag: resource.etag }),
        },
      });
      assertSuccessfulResponse(response);
      return getResource(resource.resourceId);
    });

  const deleteResource = (resource: CalendarResource): Promise<void> =>
    protect(async () => {
      await authorizeWrite(resource);
      const response = await client.deleteCalendarObject({
        calendarObject: {
          url: resource.url,
          data: resource.data,
          ...(resource.etag === null ? {} : { etag: resource.etag }),
        },
      });
      assertSuccessfulResponse(response);
    });

  const authorizeWrite = async (resource: CalendarResource): Promise<void> => {
    if (config.allowedCalendarId === undefined) {
      return;
    }
    const calendar = await resolveCalendar(resource.calendarId);
    const handle = readResourceId(resource.resourceId);
    if (
      createCalendarId(handle.calendarUrl) !== config.allowedCalendarId ||
      handle.resourceUrl !== resource.url
    ) {
      throw accessDenied();
    }
    assertResourceUrl(calendar, resource.url);
  };

  return {
    listCalendars,
    listResources,
    getResource,
    createResource,
    updateResource,
    deleteResource,
  };
};
