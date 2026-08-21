export function erlangC(capacity, offeredLoad) {
  let erlangB = 1;
  for (let slot = 1; slot <= capacity; slot += 1) {
    erlangB = (offeredLoad * erlangB) / (slot + offeredLoad * erlangB);
  }

  const utilization = offeredLoad / capacity;
  if (utilization >= 1) return 1;
  return erlangB / (1 - utilization * (1 - erlangB));
}

const PERCENTILE_METRICS = new Map([
  [0.9, 'p90'],
  [0.95, 'p95'],
  [0.99, 'p99'],
]);

function assertPositiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label}必须是大于 0 的有限数值`);
  }
}

function describeDiscreteMoments(values) {
  const meanServiceTime = values.reduce(
    (sum, item) => sum + item.value * item.probability,
    0,
  );
  const variance = values.reduce(
    (sum, item) =>
      sum + item.probability * (item.value - meanServiceTime) ** 2,
    0,
  );
  const serviceCv = Math.sqrt(variance) / meanServiceTime;
  return {
    meanServiceTime,
    serviceCv,
    serviceScv: serviceCv ** 2,
  };
}

export function createUniformServiceModel({
  minServiceTime,
  maxServiceTime,
}) {
  assertPositiveNumber(minServiceTime, '任务处理时长下限');
  assertPositiveNumber(maxServiceTime, '任务处理时长上限');
  if (maxServiceTime < minServiceTime) {
    throw new RangeError('任务处理时长上限不能小于下限');
  }
  const meanServiceTime = (minServiceTime + maxServiceTime) / 2;
  const serviceCv =
    (maxServiceTime - minServiceTime) /
    (Math.sqrt(3) * (maxServiceTime + minServiceTime));
  return {
    kind: 'uniform',
    minServiceTime,
    maxServiceTime,
    meanServiceTime,
    serviceCv,
    serviceScv: serviceCv ** 2,
  };
}

export function createWorkloadMixServiceModel(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new RangeError('工作负载组合至少需要一行：名称, 时长秒数, 占比%');
  }

  const components = lines.map((line, index) => {
    const fields = line.split(/[,，]/).map((field) => field.trim());
    if (fields.length !== 3 || fields.some((field) => field === '')) {
      throw new RangeError(`第 ${index + 1} 行格式无效，应为：名称, 时长秒数, 占比%`);
    }
    const durationSeconds = Number(fields[1]);
    const sharePercent = Number(fields[2].replace(/%$/, ''));
    assertPositiveNumber(durationSeconds, `第 ${index + 1} 行任务时长`);
    assertPositiveNumber(sharePercent, `第 ${index + 1} 行占比`);
    return {
      name: fields[0],
      durationSeconds,
      sharePercent,
    };
  });
  const totalShare = components.reduce(
    (sum, component) => sum + component.sharePercent,
    0,
  );
  if (Math.abs(totalShare - 100) > 1e-6) {
    throw new RangeError(`占比总和必须为 100%，当前为 ${totalShare}%`);
  }

  const values = components
    .map((component) => ({
      value: component.durationSeconds,
      probability: component.sharePercent / 100,
    }))
    .sort((left, right) => left.value - right.value);
  return {
    kind: 'workload-mix',
    components,
    values,
    ...describeDiscreteMoments(values),
  };
}

export function createEmpiricalServiceModel(text) {
  const tokens = String(text).trim().split(/[\s,，]+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new RangeError('实测样本不能为空；请粘贴以秒为单位的正数');
  }
  const samples = tokens.map((token, index) => {
    const value = Number(token);
    if (!Number.isFinite(value)) {
      throw new RangeError(`第 ${index + 1} 个样本“${token}”不是有效秒数`);
    }
    assertPositiveNumber(value, `第 ${index + 1} 个样本`);
    return value;
  });
  const sortedSamples = [...samples].sort((left, right) => left - right);
  const probability = 1 / sortedSamples.length;
  const values = sortedSamples.map((value) => ({ value, probability }));
  return {
    kind: 'empirical',
    samples: sortedSamples,
    values,
    ...describeDiscreteMoments(values),
  };
}

function interpolateSortedPercentile(sortedValues, percentile) {
  const index = (sortedValues.length - 1) * percentile;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const fraction = index - lowerIndex;
  return (
    sortedValues[lowerIndex] * (1 - fraction) +
    sortedValues[upperIndex] * fraction
  );
}

export function serviceTimePercentile(serviceModel, percentile) {
  return getServiceModelBehavior(serviceModel).percentile(
    serviceModel,
    percentile,
  );
}

function discretePercentile(serviceModel, percentile) {
  let cumulative = 0;
  for (const item of serviceModel.values) {
    cumulative += item.probability;
    if (cumulative + Number.EPSILON >= percentile) return item.value;
  }
  return serviceModel.values.at(-1).value;
}

export function sampleServiceTime(serviceModel, random = Math.random) {
  return getServiceModelBehavior(serviceModel).sample(serviceModel, random());
}

function discreteSample(serviceModel, draw) {
  let cumulative = 0;
  for (const item of serviceModel.values) {
    cumulative += item.probability;
    if (draw < cumulative) return item.value;
  }
  return serviceModel.values.at(-1).value;
}

function resolveServiceModel({ serviceModel, minServiceTime, maxServiceTime }) {
  return (
    serviceModel ??
    createUniformServiceModel({ minServiceTime, maxServiceTime })
  );
}

export function getPercentileEstimate(metrics, percentile) {
  const metricName = PERCENTILE_METRICS.get(percentile);
  if (!metricName) {
    throw new RangeError(`Unsupported service objective percentile: ${percentile}`);
  }
  return metrics[metricName];
}

export function describeUniformService({
  minServiceTime,
  maxServiceTime,
  percentile,
}) {
  const model = createUniformServiceModel({ minServiceTime, maxServiceTime });
  return {
    meanServiceTime: model.meanServiceTime,
    serviceCv: model.serviceCv,
    serviceScv: model.serviceScv,
    servicePercentile:
      percentile === undefined
        ? undefined
        : serviceTimePercentile(model, percentile),
  };
}

function uniformSurvival(time, minServiceTime, maxServiceTime) {
  const width = maxServiceTime - minServiceTime;
  if (width < 1e-6) return time < minServiceTime ? 1 : 0;
  if (time <= minServiceTime) return 1;
  if (time >= maxServiceTime) return 0;
  return (maxServiceTime - time) / width;
}

function waitingAndServiceSurvival(
  time,
  conditionalWaitRate,
  minServiceTime,
  maxServiceTime,
) {
  const width = maxServiceTime - minServiceTime;
  if (width < 1e-6) {
    return time <= minServiceTime
      ? 1
      : Math.exp(-conditionalWaitRate * (time - minServiceTime));
  }
  if (time <= minServiceTime) return 1;
  if (time >= maxServiceTime) {
    return (
      (Math.exp(-conditionalWaitRate * (time - maxServiceTime)) -
        Math.exp(-conditionalWaitRate * (time - minServiceTime))) /
      (conditionalWaitRate * width)
    );
  }
  return (
    ((1 - Math.exp(-conditionalWaitRate * (time - minServiceTime))) /
      conditionalWaitRate +
      (maxServiceTime - time)) /
    width
  );
}

function discreteServiceSurvival(time, serviceModel) {
  return serviceModel.values.reduce(
    (sum, item) => sum + (item.value > time ? item.probability : 0),
    0,
  );
}

function discreteWaitingAndServiceSurvival(
  time,
  conditionalWaitRate,
  serviceModel,
) {
  return serviceModel.values.reduce((sum, item) => {
    const survival =
      time <= item.value
        ? 1
        : Math.exp(-conditionalWaitRate * (time - item.value));
    return sum + item.probability * survival;
  }, 0);
}

const SERVICE_MODEL_BEHAVIORS = {
  uniform: {
    percentile: (model, percentile) =>
      model.minServiceTime +
      percentile * (model.maxServiceTime - model.minServiceTime),
    sample: (model, draw) =>
      model.minServiceTime +
      draw * (model.maxServiceTime - model.minServiceTime),
    survival: (model, time) =>
      uniformSurvival(time, model.minServiceTime, model.maxServiceTime),
    queuedSurvival: (model, time, conditionalWaitRate) =>
      waitingAndServiceSurvival(
        time,
        conditionalWaitRate,
        model.minServiceTime,
        model.maxServiceTime,
      ),
    maximum: (model) => model.maxServiceTime,
  },
  empirical: {
    percentile: (model, percentile) => {
      const index = Math.max(
        0,
        Math.ceil(percentile * model.samples.length) - 1,
      );
      return model.samples[index];
    },
    sample: (model, draw) =>
      model.samples[
        Math.min(model.samples.length - 1, Math.floor(draw * model.samples.length))
      ],
    survival: (model, time) => discreteServiceSurvival(time, model),
    queuedSurvival: (model, time, conditionalWaitRate) =>
      discreteWaitingAndServiceSurvival(time, conditionalWaitRate, model),
    maximum: (model) => model.values.at(-1).value,
  },
  'workload-mix': {
    percentile: discretePercentile,
    sample: discreteSample,
    survival: (model, time) => discreteServiceSurvival(time, model),
    queuedSurvival: (model, time, conditionalWaitRate) =>
      discreteWaitingAndServiceSurvival(time, conditionalWaitRate, model),
    maximum: (model) => model.values.at(-1).value,
  },
};

function getServiceModelBehavior(serviceModel) {
  const behavior = SERVICE_MODEL_BEHAVIORS[serviceModel.kind];
  if (!behavior) {
    throw new RangeError(`不支持的服务时间模型：${serviceModel.kind}`);
  }
  return behavior;
}

export function totalLatencySurvival({
  time,
  waitProbability,
  conditionalWaitRate,
  serviceModel,
  minServiceTime,
  maxServiceTime,
}) {
  const model = resolveServiceModel({
    serviceModel,
    minServiceTime,
    maxServiceTime,
  });
  const behavior = getServiceModelBehavior(model);
  const serviceSurvival = behavior.survival(model, time);
  if (waitProbability <= 0 || !Number.isFinite(conditionalWaitRate)) {
    return serviceSurvival;
  }

  const queuedSurvival = behavior.queuedSurvival(
    model,
    time,
    conditionalWaitRate,
  );
  return (
    (1 - waitProbability) * serviceSurvival +
    waitProbability * queuedSurvival
  );
}

export function estimateLatencyPercentile({
  percentile,
  waitProbability,
  conditionalWaitRate,
  serviceModel,
  minServiceTime,
  maxServiceTime,
}) {
  const model = resolveServiceModel({
    serviceModel,
    minServiceTime,
    maxServiceTime,
  });
  const targetSurvival = 1 - percentile;
  const maximumServiceTime = getServiceModelBehavior(model).maximum(model);
  let upper = Math.max(maximumServiceTime, 1);
  while (
    totalLatencySurvival({
      time: upper,
      waitProbability,
      conditionalWaitRate,
      serviceModel: model,
    }) > targetSurvival &&
    upper < 1e9
  ) {
    upper *= 2;
  }

  let lower = 0;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    const survival = totalLatencySurvival({
      time: midpoint,
      waitProbability,
      conditionalWaitRate,
      serviceModel: model,
    });
    if (survival > targetSurvival) lower = midpoint;
    else upper = midpoint;
  }
  return (lower + upper) / 2;
}

export function estimateCapacityMetrics({
  capacity,
  arrivalRate,
  arrivalCv = 1,
  serviceModel,
  minServiceTime,
  maxServiceTime,
}) {
  const model = resolveServiceModel({
    serviceModel,
    minServiceTime,
    maxServiceTime,
  });
  const { meanServiceTime, serviceScv } = model;
  const serviceRate = 1 / meanServiceTime;
  const offeredLoad = arrivalRate * meanServiceTime;
  const spareRate = capacity * serviceRate - arrivalRate;
  if (spareRate <= 0) return { stable: false };

  const waitProbability = erlangC(capacity, offeredLoad);
  const arrivalScv = arrivalCv ** 2;
  const meanWait =
    (waitProbability / spareRate) * ((arrivalScv + serviceScv) / 2);
  const conditionalWaitRate =
    waitProbability > 0 && meanWait > 0
      ? waitProbability / meanWait
      : Number.POSITIVE_INFINITY;
  const percentile = (value) =>
    estimateLatencyPercentile({
      percentile: value,
      waitProbability,
      conditionalWaitRate,
      serviceModel: model,
    });

  return {
    stable: true,
    utilization: offeredLoad / capacity,
    mean: meanWait + meanServiceTime,
    p90: percentile(0.9),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}

export function calculateCapacityCost({
  capacity,
  monthlySlotPrice,
  dailyTaskVolume,
}) {
  const hasPrice =
    Number.isFinite(monthlySlotPrice) && monthlySlotPrice >= 0;
  const monthlyCost = hasPrice ? capacity * monthlySlotPrice : null;
  const hasVolume = Number.isFinite(dailyTaskVolume) && dailyTaskVolume > 0;
  return {
    monthlyCost,
    costPerTask:
      monthlyCost !== null && hasVolume
        ? monthlyCost / (dailyTaskVolume * 30)
        : null,
  };
}

export function calculateDesignArrivalRate({ observedRate, peakFactor = 1 }) {
  return observedRate * peakFactor;
}

export function recommendProductionCapacity({
  theoreticalCapacity,
  offeredLoad,
  maxUtilization = 0.8,
  redundancy = 1,
}) {
  const utilizationCapacity =
    maxUtilization === null
      ? theoreticalCapacity
      : Math.ceil(offeredLoad / maxUtilization);
  const baseCapacity = Math.max(
    theoreticalCapacity,
    utilizationCapacity,
  );
  const normalizedRedundancy = Math.max(0, Math.floor(redundancy));
  return {
    redundancy: normalizedRedundancy,
    productionCapacity: baseCapacity + normalizedRedundancy,
  };
}

export function findMinimumCapacity({
  arrivalRate,
  serviceModel,
  minServiceTime,
  maxServiceTime,
  percentile,
  objectiveSeconds,
  arrivalCv = 1,
  maxCapacity = 100_000,
}) {
  const model = resolveServiceModel({
    serviceModel,
    minServiceTime,
    maxServiceTime,
  });
  const { meanServiceTime } = model;
  const servicePercentile = serviceTimePercentile(model, percentile);
  const offeredLoad = arrivalRate * meanServiceTime;
  const minimumStableCapacity = Math.max(1, Math.floor(offeredLoad) + 1);
  getPercentileEstimate({}, percentile);
  if (objectiveSeconds <= servicePercentile) {
    return {
      status: 'impossible-objective',
      minimumStableCapacity,
      servicePercentile,
    };
  }
  if (minimumStableCapacity > maxCapacity) {
    return { status: 'search-limit', minimumStableCapacity, maxCapacity };
  }

  const evaluated = new Map();
  const evaluate = (capacity) => {
    if (evaluated.has(capacity)) return evaluated.get(capacity);
    const value = estimateCapacityMetrics({
      capacity,
      arrivalRate,
      arrivalCv,
      serviceModel: model,
    });
    evaluated.set(capacity, value);
    return value;
  };
  const meetsObjective = (capacity) =>
    getPercentileEstimate(evaluate(capacity), percentile) <= objectiveSeconds;

  if (meetsObjective(minimumStableCapacity)) {
    return {
      status: 'found',
      capacity: minimumStableCapacity,
      metrics: evaluate(minimumStableCapacity),
      minimumStableCapacity,
    };
  }
  if (minimumStableCapacity === maxCapacity) {
    return { status: 'search-limit', minimumStableCapacity, maxCapacity };
  }

  let lastFailure = minimumStableCapacity;
  let step = 1;
  let upper = minimumStableCapacity;
  while (upper < maxCapacity) {
    upper = Math.min(maxCapacity, minimumStableCapacity + step);
    if (meetsObjective(upper)) break;
    lastFailure = upper;
    if (upper === maxCapacity) {
      return { status: 'search-limit', minimumStableCapacity, maxCapacity };
    }
    step *= 2;
  }

  let lower = lastFailure + 1;
  while (lower < upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    if (meetsObjective(midpoint)) upper = midpoint;
    else lower = midpoint + 1;
  }

  return {
    status: 'found',
    capacity: lower,
    metrics: evaluate(lower),
    minimumStableCapacity,
  };
}

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleStandardNormal(random) {
  const first = Math.max(Number.MIN_VALUE, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function sampleGamma(shape, random) {
  if (shape < 1) {
    return sampleGamma(shape + 1, random) * random() ** (1 / shape);
  }
  const offset = shape - 1 / 3;
  const scale = 1 / Math.sqrt(9 * offset);
  while (true) {
    const normal = sampleStandardNormal(random);
    const transformed = (1 + scale * normal) ** 3;
    if (transformed <= 0) continue;
    const draw = random();
    if (
      draw < 1 - 0.0331 * normal ** 4 ||
      Math.log(draw) <
        0.5 * normal ** 2 + offset * (1 - transformed + Math.log(transformed))
    ) {
      return offset * transformed;
    }
  }
}

function sampleGammaRenewalInterval(arrivalRate, arrivalCv, random) {
  const shape = 1 / arrivalCv ** 2;
  const scale = 1 / (arrivalRate * shape);
  return sampleGamma(shape, random) * scale;
}

const STUDENT_T_975 = [
  undefined,
  12.706,
  4.303,
  3.182,
  2.776,
  2.571,
  2.447,
  2.365,
  2.306,
  2.262,
  2.228,
  2.201,
  2.179,
  2.16,
  2.145,
  2.131,
  2.12,
  2.11,
  2.101,
  2.093,
  2.086,
  2.08,
  2.074,
  2.069,
  2.064,
  2.06,
  2.056,
  2.052,
  2.048,
  2.045,
  2.042,
];

export function calculateStudentTCritical95(degreesOfFreedom) {
  if (!Number.isInteger(degreesOfFreedom) || degreesOfFreedom < 1) {
    throw new RangeError('t 区间自由度必须是正整数');
  }
  if (degreesOfFreedom < STUDENT_T_975.length) {
    return STUDENT_T_975[degreesOfFreedom];
  }
  const z = 1.959963984540054;
  const inverseDf = 1 / degreesOfFreedom;
  return (
    z +
    ((z ** 3 + z) / 4) * inverseDf +
    ((5 * z ** 5 + 16 * z ** 3 + 3 * z) / 96) * inverseDf ** 2 +
    ((3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / 384) *
      inverseDf ** 3
  );
}

function summarizeRepetitions(values) {
  const estimate = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) {
    return { estimate, lower: estimate, upper: estimate, repetitions: 1 };
  }
  const variance = values.reduce(
    (sum, value) => sum + (value - estimate) ** 2,
    0,
  ) / (values.length - 1);
  const tCritical = calculateStudentTCritical95(values.length - 1);
  const margin = tCritical * Math.sqrt(variance / values.length);
  return {
    estimate,
    lower: Math.max(0, estimate - margin),
    upper: estimate + margin,
    repetitions: values.length,
  };
}

function replaceEarliestAvailability(availabilityHeap, nextAvailability) {
  availabilityHeap[0] = nextAvailability;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let earliest = index;
    if (
      left < availabilityHeap.length &&
      availabilityHeap[left] < availabilityHeap[earliest]
    ) {
      earliest = left;
    }
    if (
      right < availabilityHeap.length &&
      availabilityHeap[right] < availabilityHeap[earliest]
    ) {
      earliest = right;
    }
    if (earliest === index) return;
    [availabilityHeap[index], availabilityHeap[earliest]] = [
      availabilityHeap[earliest],
      availabilityHeap[index],
    ];
    index = earliest;
  }
}

function simulateOneRepetition({
  capacity,
  arrivalRate,
  arrivalCv,
  serviceModel,
  warmupTasks,
  measuredTasks,
  seed,
}) {
  const random = createSeededRandom(seed);
  const availabilityHeap = Array.from({ length: capacity }, () => 0);
  const latencies = [];
  let arrivalTime = 0;
  const taskCount = warmupTasks + measuredTasks;

  for (let task = 0; task < taskCount; task += 1) {
    arrivalTime += sampleGammaRenewalInterval(
      arrivalRate,
      arrivalCv,
      random,
    );
    const serviceTime = sampleServiceTime(serviceModel, random);
    const startedAt = Math.max(arrivalTime, availabilityHeap[0]);
    const completedAt = startedAt + serviceTime;
    replaceEarliestAvailability(availabilityHeap, completedAt);
    if (task >= warmupTasks) {
      latencies.push(completedAt - arrivalTime);
    }
  }
  latencies.sort((left, right) => left - right);
  return {
    mean: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    p90: interpolateSortedPercentile(latencies, 0.9),
    p95: interpolateSortedPercentile(latencies, 0.95),
    p99: interpolateSortedPercentile(latencies, 0.99),
  };
}

export function simulateCapacity({
  capacity,
  arrivalRate,
  arrivalCv = 1,
  serviceModel,
  warmupTasks = 2_000,
  measuredTasks = 8_000,
  repetitions = 5,
  seed = 20260821,
}) {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError('仿真容量必须是正整数');
  }
  assertPositiveNumber(arrivalRate, '仿真到达率');
  assertPositiveNumber(arrivalCv, '仿真到达变异系数');
  if (!serviceModel) throw new TypeError('仿真必须提供明确的服务时间模型');
  if (!Number.isInteger(warmupTasks) || warmupTasks < 0) {
    throw new RangeError('预热任务数必须是非负整数');
  }
  if (warmupTasks > 100_000) {
    throw new RangeError('单次预热任务数不能超过 100,000');
  }
  if (!Number.isInteger(measuredTasks) || measuredTasks < 100) {
    throw new RangeError('每次重复至少需要 100 个计量任务');
  }
  if (measuredTasks > 100_000) {
    throw new RangeError('每次重复的计量任务数不能超过 100,000');
  }
  if (!Number.isInteger(repetitions) || repetitions < 2) {
    throw new RangeError('仿真至少需要重复 2 次以报告不确定性');
  }
  if (repetitions > 30) {
    throw new RangeError('仿真重复次数不能超过 30');
  }
  if (
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff
  ) {
    throw new RangeError('随机种子必须是 0 到 4,294,967,295 之间的整数');
  }

  const results = Array.from({ length: repetitions }, (_, repetition) =>
    simulateOneRepetition({
      capacity,
      arrivalRate,
      arrivalCv,
      serviceModel,
      warmupTasks,
      measuredTasks,
      seed: seed + repetition * 0x9e3779b1,
    }),
  );
  return {
    capacity,
    warmupTasks,
    measuredTasks,
    sampleSize: measuredTasks * repetitions,
    repetitions,
    mean: summarizeRepetitions(results.map((result) => result.mean)),
    p90: summarizeRepetitions(results.map((result) => result.p90)),
    p95: summarizeRepetitions(results.map((result) => result.p95)),
    p99: summarizeRepetitions(results.map((result) => result.p99)),
  };
}

export function runSimulationCheck({
  analyticalCapacity,
  arrivalRate,
  arrivalCv = 1,
  serviceModel,
  percentile,
  objectiveSeconds,
  warmupTasks = 2_000,
  measuredTasks = 8_000,
  repetitions = 5,
  seed = 20260821,
  maxCapacity = 100_000,
  maxEvaluations = 128,
}) {
  if (!Number.isInteger(maxEvaluations) || maxEvaluations < 1) {
    throw new RangeError('仿真候选评估上限必须是正整数');
  }
  const offeredLoad = arrivalRate * serviceModel.meanServiceTime;
  const minimumStableCapacity = Math.max(1, Math.floor(offeredLoad) + 1);
  const firstCapacity = Math.max(minimumStableCapacity, analyticalCapacity);
  if (firstCapacity > maxCapacity) {
    return {
      status: 'search-limit',
      recommendedCapacity: null,
      minimumStableCapacity,
      maxCapacity,
      evaluations: [],
    };
  }
  const metricName = PERCENTILE_METRICS.get(percentile);
  if (!metricName) {
    throw new RangeError(`Unsupported service objective percentile: ${percentile}`);
  }

  const evaluated = new Map();
  const evaluate = (capacity) => {
    if (!evaluated.has(capacity)) {
      const simulation = simulateCapacity({
        capacity,
        arrivalRate,
        arrivalCv,
        serviceModel,
        warmupTasks,
        measuredTasks,
        repetitions,
        seed,
      });
      evaluated.set(capacity, {
        capacity,
        simulation,
        meetsObjective: simulation[metricName].upper <= objectiveSeconds,
      });
    }
    return evaluated.get(capacity);
  };

  evaluate(firstCapacity);
  let reachedMinimumStableCapacity =
    firstCapacity === minimumStableCapacity;
  for (
    let candidate = firstCapacity - 1;
    candidate >= minimumStableCapacity && evaluated.size < maxEvaluations;
    candidate -= 1
  ) {
    evaluate(candidate);
    reachedMinimumStableCapacity = candidate === minimumStableCapacity;
  }

  let recommendedCapacity = reachedMinimumStableCapacity
    ? [...evaluated.values()]
        .filter((evaluation) => evaluation.meetsObjective)
        .reduce(
          (minimum, evaluation) =>
            Math.min(minimum, evaluation.capacity),
          Number.POSITIVE_INFINITY,
        )
    : null;
  if (!Number.isFinite(recommendedCapacity)) recommendedCapacity = null;

  if (reachedMinimumStableCapacity && recommendedCapacity === null) {
    let scannedThrough = firstCapacity;
    let windowSize = 1;
    while (
      scannedThrough < maxCapacity &&
      evaluated.size < maxEvaluations &&
      recommendedCapacity === null
    ) {
      const windowEnd = Math.min(
        maxCapacity,
        scannedThrough + windowSize,
      );
      for (
        let candidate = scannedThrough + 1;
        candidate <= windowEnd && evaluated.size < maxEvaluations;
        candidate += 1
      ) {
        if (evaluate(candidate).meetsObjective) {
          recommendedCapacity = candidate;
          break;
        }
      }
      scannedThrough = windowEnd;
      windowSize *= 2;
    }
  }

  if (recommendedCapacity === null) {
    return {
      status: 'search-limit',
      recommendedCapacity: null,
      minimumStableCapacity,
      maxCapacity,
      maxEvaluations,
      evaluations: [...evaluated.values()].sort(
        (left, right) => left.capacity - right.capacity,
      ),
    };
  }

  return {
    status: 'found',
    recommendedCapacity,
    minimumStableCapacity,
    evaluations: [...evaluated.values()].sort(
      (left, right) => left.capacity - right.capacity,
    ),
  };
}
