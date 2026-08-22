import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { RgapClient, RgapProvider } from '@rgap/react';
import { routeTree } from './routeTree.gen';
import { store } from './repository';
import './styles.css';

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

RgapClient.connect(store.admin()).then((client) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RgapProvider client={client}>
        <RouterProvider router={router} />
      </RgapProvider>
    </StrictMode>,
  );
});
