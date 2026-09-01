export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex size-24 items-center justify-center" aria-label="Ditto splash screen">
        <img alt="Ditto" className="h-auto w-20 dark:invert" src="/ditto-wordmark.svg" />
      </div>
    </div>
  );
}
