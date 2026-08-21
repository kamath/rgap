import { BrowserRgapRepository } from '@rgap/browser';
import { seed } from './seed';

/** The administrative plane. Commands run here directly, or through `guardCommands` when a token is active. */
export const repository = new BrowserRgapRepository({ initialState: seed() });
