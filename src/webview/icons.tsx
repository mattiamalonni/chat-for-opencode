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
        {glyph && (
          <path
            d={glyph}
            fill="none"
            stroke="currentColor"
            stroke-width="1.1"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        )}
      </svg>
    );
  };

export const IconSend = svg("M1.7 1.3 15 8 1.7 14.7l1.6-5.9L10 8 3.3 7.2z");
export const IconStop = svg("M3 3h10v10H3z");
export const IconPlus = svg("M7.25 2h1.5v5.25H14v1.5H8.75V14h-1.5V8.75H2v-1.5h5.25z");
export const IconClose = svg("m8 7 4-4 1 1-4 4 4 4-1 1-4-4-4 4-1-1 4-4-4-4 1-1z");
export const IconChevron = svg("M5.7 3.3 10.4 8l-4.7 4.7-1-1L8.4 8 4.7 4.3z");
export const IconFile = svg("M3 1h6.4L13 4.6V15H3zm1 1v12h8V5H9V2zm6 .4V4h1.6z");
export const IconFileCode = fileSvg("M6.3 8 4.8 9.5 6.3 11M9.7 8l1.5 1.5-1.5 1.5M8.6 7.4 7.4 12.6");
export const IconFileMarkdown = fileSvg("M4.9 12V8.6l1.3 1.8 1.3-1.8V12M9.5 12V8.6M9.5 10.2l2-1.6M9.5 10.2l2 1.8");
export const IconFileJson = fileSvg("M6.5 8.2c-.8 0-1.2.4-1.2 1.1v.7c0 .6-.2.9-.6 1.1.4.2.6.5.6 1.1v.7c0 .7.4 1.1 1.2 1.1M9.5 8.2c.8 0 1.2.4 1.2 1.1v.7c0 .6.2.9.6 1.1-.4.2-.6.5-.6 1.1v.7c0 .7-.4 1.1-1.2 1.1");
export const IconFileImage = fileSvg("M4.9 12.4l2-2.3 1.3 1.4 1-1.1 1.2 2M6.3 8.4a.7.7 0 1 0 0 1.4.7.7 0 0 0 0-1.4");
export const IconFileStyle = fileSvg("M6.5 8 5.9 12M9.1 8l-.6 4M5.2 9.3h6M5 10.8h6");
export const IconFileShell = fileSvg("M5.2 8.6 6.8 10l-1.6 1.4M7.9 11.6H11");
export const IconFileConfig = fileSvg("M5 8.6h6M6.4 8v1.2M5 10.6h6M9.6 10v1.2M5 12.4h6M7.4 11.8V13");
export const IconFileData = fileSvg("M5 8h6v5H5zm0 1.7h6M8 8v5");
export const IconFileDoc = fileSvg("M5 8.6h6M5 10.4h6M5 12.2h3.8");
export const IconSelection = svg("M2 3h12v1H2zm0 3h8v1H2zm0 3h12v1H2zm0 3h6v1H2z");
export const IconTool = svg("M13.6 2.4a3.5 3.5 0 0 0-4.7 4.2L2.2 13.3l1.5 1.5 6.7-6.7a3.5 3.5 0 0 0 4.2-4.7l-2 2-1.5-.4-.4-1.5z");
export const IconCheck = svg("M6.3 11.3 2.7 7.7l-1 1 4.6 4.6 8-8-1-1z");
export const IconShield = function IconShield(props: P) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true" focusable="false" {...props}>
      <path d="M8 1.6 3 3.4v4c0 3.1 2 5.7 5 6.9 3-1.2 5-3.8 5-6.9v-4z" stroke-linejoin="round" />
      <path d="m5.9 7.9 1.4 1.4 2.8-3" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
};
export const IconError = svg("M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm-.7 3v5h1.4V4zm0 6.3v1.4h1.4v-1.4z");
export const IconWarning = svg("M8 1 15 14H1zm-.7 4v4.5h1.4V5zm0 5.8v1.4h1.4v-1.4z");
export const IconInfo = svg("M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm-.7 6v5h1.4V7zm0-2.7v1.4h1.4V4.3z");
export const IconTrash = svg("M6 1h4v1h4v1H2V2h4zM3 4h10l-1 11H4zm2 1 .6 9h1L6 5zm4.4 0L9 14h1l.6-9z");
export const IconDiff = svg("M4 1h1v3h3v1H5v3H4V5H1V4h3zm-3 10h7v1H1zm9-10 5 5-5 5V1z");
export const IconRefresh = svg("M13.5 8A5.5 5.5 0 1 1 11.8 4H9.5V3h4v4h-1V4.9A6.5 6.5 0 1 0 14.5 8z");
export const IconAt = svg("M8 1a7 7 0 0 0 0 14h3v-1.4H8A5.6 5.6 0 1 1 13.6 8v.8c0 .7-.5 1.2-1.1 1.2s-1.1-.5-1.1-1.2V5h-1.3v.5A3.2 3.2 0 1 0 10.7 10a2.4 2.4 0 0 0 4.3-1.2V8a7 7 0 0 0-7-7zm0 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4z");
export const IconHistory = svg("M8 1a7 7 0 1 1-6.6 9.3l1.3-.4A5.6 5.6 0 1 0 3 5H5v1.3H1V2.3h1.3v1.5A7 7 0 0 1 8 1zm-.7 3h1.4v3.7l2.8 1.7-.7 1.2-3.5-2.1z");
