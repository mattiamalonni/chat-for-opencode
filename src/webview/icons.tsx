import type { FunctionComponent, SVGAttributes } from "preact";

type P = SVGAttributes<SVGSVGElement>;

const svg = (d: string): FunctionComponent<P> =>
  function Icon(props: P) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
        <path d={d} />
      </svg>
    );
  };

/** File outline with an optional stroke-only glyph in the lower half. */
const fileSvg = (glyph?: string): FunctionComponent<P> =>
  function Icon(props: P) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
        <path d="M3 1h6.4L13 4.6V15H3zm1 1v12h8V5H9V2zm6 .4V4h1.6z" />
        {glyph && <path d={glyph} fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />}
      </svg>
    );
  };

export const IconSend = svg("M1.7 1.3 15 8 1.7 14.7l1.6-5.9L10 8 3.3 7.2z");
export const IconStop = svg("M3 3h10v10H3z");
export const IconPlus = svg("M7.25 2h1.5v5.25H14v1.5H8.75V14h-1.5V8.75H2v-1.5h5.25z");
export const IconClose = svg("m8 7 4-4 1 1-4 4 4 4-1 1-4-4-4 4-1-1 4-4-4-4 1-1z");
export const IconChevron = svg("M5.7 3.3 10.4 8l-4.7 4.7-1-1L8.4 8 4.7 4.3z");
export const IconFile = svg("M3 1h6.4L13 4.6V15H3zm1 1v12h8V5H9V2zm6 .4V4h1.6z");
export const IconFolder = svg("M1.5 2.5h4.2l1.6 1.8h7.2V14H1.5zm1 1.3v8.9h10.5V5.6H6.5z");
export const IconFileCode = fileSvg("M6.3 8 4.8 9.5 6.3 11M9.7 8l1.5 1.5-1.5 1.5M8.6 7.4 7.4 12.6");
export const IconFileMarkdown = fileSvg("M4.9 12V8.6l1.3 1.8 1.3-1.8V12M9.5 12V8.6M9.5 10.2l2-1.6M9.5 10.2l2 1.8");
export const IconFileJson = fileSvg(
  "M6.5 8.2c-.8 0-1.2.4-1.2 1.1v.7c0 .6-.2.9-.6 1.1.4.2.6.5.6 1.1v.7c0 .7.4 1.1 1.2 1.1M9.5 8.2c.8 0 1.2.4 1.2 1.1v.7c0 .6.2.9.6 1.1-.4.2-.6.5-.6 1.1v.7c0 .7-.4 1.1-1.2 1.1",
);
export const IconFileImage = fileSvg("M4.9 12.4l2-2.3 1.3 1.4 1-1.1 1.2 2M6.3 8.4a.7.7 0 1 0 0 1.4.7.7 0 0 0 0-1.4");
export const IconFileStyle = fileSvg("M6.5 8 5.9 12M9.1 8l-.6 4M5.2 9.3h6M5 10.8h6");
export const IconFileShell = fileSvg("M5.2 8.6 6.8 10l-1.6 1.4M7.9 11.6H11");
export const IconFileConfig = fileSvg("M5 8.6h6M6.4 8v1.2M5 10.6h6M9.6 10v1.2M5 12.4h6M7.4 11.8V13");
export const IconFileData = fileSvg("M5 8h6v5H5zm0 1.7h6M8 8v5");
export const IconFileDoc = fileSvg("M5 8.6h6M5 10.4h6M5 12.2h3.8");
export const IconSelection = svg("M2 3h12v1H2zm0 3h8v1H2zm0 3h12v1H2zm0 3h6v1H2z");
export const IconTool = svg("M13.6 2.4a3.5 3.5 0 0 0-4.7 4.2L2.2 13.3l1.5 1.5 6.7-6.7a3.5 3.5 0 0 0 4.2-4.7l-2 2-1.5-.4-.4-1.5z");
export const IconCheck = svg("M6.3 11.3 2.7 7.7l-1 1 4.6 4.6 8-8-1-1z");
export const IconCopy = svg("M5.5 2h7.5v9h-1.5V3.5H5.5zm-3 3h7.5v9H2.5zm1.5 1.5v6h4.5v-6z");
export const IconShield = function IconShield(props: P) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M8 1.6 3 3.4v4c0 3.1 2 5.7 5 6.9 3-1.2 5-3.8 5-6.9v-4z" stroke-linejoin="round" />
      <path d="m5.9 7.9 1.4 1.4 2.8-3" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
};
export const IconError = svg("M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm-.7 3v5h1.4V4zm0 6.3v1.4h1.4v-1.4z");
export const IconWarning = svg("M8 1 15 14H1zm-.7 4v4.5h1.4V5zm0 5.8v1.4h1.4v-1.4z");
export const IconInfo = svg("M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm-.7 6v5h1.4V7zm0-2.7v1.4h1.4V4.3z");
export const IconTrash = svg("M6 1h4v1h4v1H2V2h4zM3 4h10l-1 11H4zm2 1 .6 9h1L6 5zm4.4 0L9 14h1l.6-9z");
export const IconEdit = svg("M11.9 1.6a1.5 1.5 0 0 1 2.1 0l.4.4a1.5 1.5 0 0 1 0 2.1L5.7 12.8 2 14l1.2-3.7z");
export const IconDiff = svg("M4 1h1v3h3v1H5v3H4V5H1V4h3zm-3 10h7v1H1zm9-10 5 5-5 5V1z");
/** Two circular arrows: reads as "refresh" even at 16px. */
export const IconRefresh = function IconRefresh(props: P) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M13.3 7.3a5.4 5.4 0 0 0-10.3-1.3M2.7 3.3v2.7h2.7" />
      <path d="M2.7 8.7a5.4 5.4 0 0 0 10.3 1.3M13.3 12.7V10h-2.7" />
    </svg>
  );
};
export const IconCompact = svg("M2 3h4v1H3v3H2zm12 0v4h-1V4h-3V3zm0 10h-4v-1h3V9h1zm-12 0h4v-1H3V9H2zM6 7.5h4v1H6z");
/** Counterclockwise arrow: "take this turn back" / rollback. */
export const IconRevert = function IconRevert(props: P) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M2.7 6.7h6.4a3.4 3.4 0 0 1 0 6.8H7" />
      <path d="M5.4 4 2.7 6.7 5.4 9.4" />
    </svg>
  );
};
/** Branching arrows: "split a new session off this turn". */
export const IconFork = function IconFork(props: P) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M8 13V8M8 8 3.5 3.5M8 8l4.5-4.5" />
      <path d="M2.5 5.4V2.5h2.9M13.5 5.4V2.5h-2.9" />
    </svg>
  );
};
export const IconHistory = svg(
  "M8 1a7 7 0 1 1-6.6 9.3l1.3-.4A5.6 5.6 0 1 0 3 5H5v1.3H1V2.3h1.3v1.5A7 7 0 0 1 8 1zm-.7 3h1.4v3.7l2.8 1.7-.7 1.2-3.5-2.1z",
);
/** Diagonal arrow out of a box: "open this in its own view". */
export const IconOpen = svg("M9 2h5v5h-1.5V4.6L9.2 8 8.1 6.9l3.4-3.4H9zM3 3h4.5v1.5H4.5v8h8V8.5H14V13H3z");
