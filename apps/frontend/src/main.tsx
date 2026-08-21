import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRgapRepository } from '@rgap/browser';
import { RgapProvider } from '@rgap/react';
import { App } from './App';
import { seed } from './seed';
import './styles.css';

const repository = new BrowserRgapRepository({ initialState: seed() });

createRoot(document.getElementById('root')!).render(
  <StrictMode><RgapProvider repository={repository}><App /></RgapProvider></StrictMode>,
);
