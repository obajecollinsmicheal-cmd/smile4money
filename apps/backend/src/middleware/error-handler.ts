import type { ErrorRequestHandler } from "express";
import { errorToHttpStatus } from "../errors/errorToHttpStatus.js";
import { errorEnvelope, statusToErrorCode } from "../errors/errorResponse.js";
import logger from "../logger.js";

export const apiErrorHandler: ErrorRequestHandler = (
  error,
  req,
  res,
  _next,
) => {
  const status = errorToHttpStatus(error);

  if (status >= 500) {
    logger.error({ status, method: req.method, error }, "http_request_failed");
  } else {
    logger.warn({ status, method: req.method, error }, "http_request_failed");
  }

  const message =
    status >= 500
      ? "An unexpected server error occurred."
      : error instanceof Error
        ? error.message
        : "The request could not be completed.";

  res.status(status).json(errorEnvelope(statusToErrorCode(status), message));
};
