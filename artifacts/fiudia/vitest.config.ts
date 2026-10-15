import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Independent of the dev-server config: tests need no PORT, BASE_PATH or services.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/TodayPulse.test.tsx'],
    clearMocks: true,
  },
});
