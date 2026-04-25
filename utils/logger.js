const serializeError = (error) => {
  if (!(error instanceof Error)) {
    return error;
  }

  return {
    name: error.name,
    message: error.message,
    code: error.code,
    statusCode: error.statusCode,
    stack: error.stack
  };
};

const writeLog = (level, message, context = {}) => {
  const payload = {
    level,
    message,
    time: new Date().toISOString(),
    ...Object.fromEntries(Object.entries(context).map(([key, value]) => [
      key,
      value instanceof Error ? serializeError(value) : value
    ]))
  };

  const line = JSON.stringify(payload);

  if (level === 'error') {
    console.error(line);
    return;
  }

  if (level === 'warn') {
    console.warn(line);
    return;
  }

  console.log(line);
};

export const logger = Object.freeze({
  info(message, context) {
    writeLog('info', message, context);
  },
  warn(message, context) {
    writeLog('warn', message, context);
  },
  error(message, context) {
    writeLog('error', message, context);
  }
});
