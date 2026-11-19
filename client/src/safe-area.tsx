// Standalone replacement for the Hatch SDK's SafeAreaTopScrim: a plain
// spacer sized to the phone's top safe-area inset (notch / status bar).
export function SafeAreaTopScrim({
  backgroundColor,
}: {
  backgroundColor?: string;
}) {
  return (
    <div
      aria-hidden="true"
      style={{
        height: "env(safe-area-inset-top, 0px)",
        backgroundColor: backgroundColor ?? "var(--bg)",
      }}
    />
  );
}
