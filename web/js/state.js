// Shared, in-memory app state. Nothing sensitive is persisted in the browser.
export const state = {
  config: null,
  user: null,
  unread: 0,
};

export const isAdmin = () => Boolean(state.user && state.user.role === 'admin');
