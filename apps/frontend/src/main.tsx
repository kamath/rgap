import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BrowserRgapRepository } from './repository';
import './styles.css';

const repository = new BrowserRgapRepository();

createRoot(document.getElementById('root')!).render(
  <StrictMode><App repository={repository} /></StrictMode>,
);
