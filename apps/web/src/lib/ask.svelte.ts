/**
 * A question typed in the command palette, handed to the Canvas in memory (not in the URL, so a
 * financial question never lands in browser history, logs or a Referer header). The Canvas takes it
 * once and submits it as if typed there.
 */
export const pendingAsk = $state({ text: "" });

export function takePendingAsk(): string {
  const t = pendingAsk.text;
  pendingAsk.text = "";
  return t;
}
