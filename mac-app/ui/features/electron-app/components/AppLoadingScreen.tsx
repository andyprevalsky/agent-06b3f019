/**
 * Full-screen loading spinner rendered while the shell resolves auth and
 * onboarding status. Presentational only — no hooks, no state.
 */
const AppLoadingScreen = () => {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
};

export default AppLoadingScreen;
