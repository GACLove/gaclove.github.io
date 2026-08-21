import { runSimulationCheck } from './model.mjs';

self.onmessage = ({ data }) => {
  try {
    self.postMessage({ result: runSimulationCheck(data) });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
