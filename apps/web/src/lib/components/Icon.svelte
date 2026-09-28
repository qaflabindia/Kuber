<script lang="ts">
  let { name, size = 18 }: { name: string; size?: number } = $props();
  const paths: Record<string, string> = {
    today: "M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0Zm8-4v4l3 2",
    review: "M5 5h14v10H9l-4 4V5Zm4 5h6M9 13h3",
    confirm: "M5 12l4 4 10-10M4 20h16",
    import: "M12 3v12m0 0-4-4m4 4 4-4M4 17v3h16v-3",
    reports: "M5 20V10m7 10V4m7 16v-7",
    ledger: "M5 4h11l3 3v13H5V4Zm4 6h6m-6 4h6m-6 4h4",
    shield: "M12 3l7 3v6c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6l7-3Zm-3 9 2 2 4-4",
    spark: "M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5m7 7L18 18M6 18l2.5-2.5m7-7L18 6",
    send: "M4 12l16-8-6 16-2.5-6.5L4 12Z",
    arrowRight: "M5 12h14m-5-5 5 5-5 5",
    check: "M5 12l4 4 10-10",
    x: "M6 6l12 12M18 6 6 18",
    signout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11",
    upload: "M12 16V4m0 0-4 4m4-4 4 4M4 16v4h16v-4",
    book: "M5 4h9a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4V4Zm0 12a4 4 0 0 1 4-4h9",
    edit: "M4 20h4L19 9l-4-4L4 16v4Z",
    members: "M15 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 8v-1a4 4 0 0 0-3-3.9M15 5.1a3 3 0 0 1 0 5.8",
    key: "M14.5 9.5a4.5 4.5 0 1 0-3.9 4.46L9 15.5V18H6.5v2.5H3.5v-3l6.04-6.04M16 8h.01",
    home: "M4 11 12 4l8 7v9h-5v-6H9v6H4v-9Z",
    bank: "M3 9 12 4l9 5M5 10v8m4.7-8v8m4.6-8v8M19 10v8M3 20h18",
    calendar: "M5 6h14v14H5V6Zm0 4h14M9 4v4m6-4v4m-6 6 2 2 4-4",
    scale: "M12 4v16M8 20h8M5 8h14M5 8l-2.5 6a3 3 0 0 0 5 0L5 8Zm14 0-2.5 6a3 3 0 0 0 5 0L19 8Z",
    list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
    doc: "M6 3h8l4 4v14H6V3Zm8 0v4h4M9 12h6m-6 4h6",
    search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 4 4",
    menu: "M4 7h16M4 12h16M4 17h16",
    panel: "M4 5h16v14H4V5Zm5 0v14",
    chevron: "M9 6l6 6-6 6",
    alert: "M12 8v5m0 3h.01M10.3 4.3 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z",
  };
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={paths[name] ?? ""} />
</svg>
