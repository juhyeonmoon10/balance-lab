import { validateConfig, runTrial, aggregateResults } from './lib/engine.js';

self.onmessage = ({ data }) => {
  const { id } = data;
  try {
    const config = validateConfig(data.config);
    const trials = [];
    for (let index = 0; index < config.trials; index++) {
      trials.push(runTrial(config, index));
      if ((index + 1) % 50 === 0) self.postMessage({ id, type: 'progress', progress: (index + 1) / config.trials });
    }
    self.postMessage({ id, type: 'complete', result: aggregateResults(config, trials) });
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error.message });
  }
};
