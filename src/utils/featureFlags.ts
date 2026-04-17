export const backendEnabled: boolean = (() => {
  const v = import.meta.env.VITE_BACKEND_ENABLED;
  return v === 'true' || v === '1' || v === true;
})();
