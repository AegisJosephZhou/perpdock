import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { MonitoringErrorBoundary } from './observability.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><MonitoringErrorBoundary><App /></MonitoringErrorBoundary></React.StrictMode>);
