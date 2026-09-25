// Shared, in-memory app state. Nothing sensitive is persisted in the browser.
export const state = {
  config: null,
  user: null,
};

export const isAdmin = () => Boolean(state.user && state.user.role === 'admin');
