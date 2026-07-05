import { createAuthClient } from 'better-auth/react';
import { usernameClient, genericOAuthClient } from 'better-auth/client/plugins';
import { API_BASE_URL } from './api';

export const authClient = createAuthClient({
  baseURL: `${API_BASE_URL}/auth`,
  plugins: [usernameClient(), genericOAuthClient()],
});
