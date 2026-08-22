import { BrowserRgapStore } from '@rgap/browser';
import { seed } from './seed';

/** Owns persistence and exposes explicit administrative and bearer-token command planes. */
export const store = new BrowserRgapStore({ initialState: seed() });
