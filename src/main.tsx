import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { PairGate } from './ui/PairGate';
import './app/App.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('The application root element is missing.');
}

createRoot(rootElement).render(
  <StrictMode>
    <PairGate which="dimension"><App /></PairGate>
  </StrictMode>,
);
