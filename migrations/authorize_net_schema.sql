-- Authorize.Net Integration Schema Changes
-- Run these SQL statements against the truNorth database

-- 1a. PaymentHistories — add gateway tracking columns
ALTER TABLE `PaymentHistories`
  ADD COLUMN `gateway` VARCHAR(50) DEFAULT 'authorize_net' AFTER `amount`,
  ADD COLUMN `authorizeTransactionId` VARCHAR(255) NULL AFTER `gateway`,
  ADD COLUMN `authorizeSubscriptionId` VARCHAR(255) NULL AFTER `authorizeTransactionId`,
  ADD COLUMN `authorizeEventId` VARCHAR(255) NULL AFTER `authorizeSubscriptionId`,
  ADD COLUMN `invoiceNumber` VARCHAR(100) NULL AFTER `authorizeEventId`;

-- 1b. Installments — add subscription & retry tracking
ALTER TABLE `Installments`
  ADD COLUMN `authorizeSubscriptionId` VARCHAR(255) NULL AFTER `installmentType`,
  ADD COLUMN `authorizeTransactionId` VARCHAR(255) NULL AFTER `authorizeSubscriptionId`,
  ADD COLUMN `attemptCount` INT NOT NULL DEFAULT 0 AFTER `authorizeTransactionId`,
  ADD COLUMN `lastAttemptAt` DATETIME NULL AFTER `attemptCount`,
  ADD COLUMN `paidAt` DATETIME NULL AFTER `lastAttemptAt`;

-- Expand status from ENUM/limited values to VARCHAR for more states
ALTER TABLE `Installments`
  MODIFY COLUMN `status` VARCHAR(50) NOT NULL DEFAULT 'pending';

-- 1c. Webhook idempotency table (new)
CREATE TABLE IF NOT EXISTS `PaymentWebhookEvents` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `eventId` VARCHAR(255) NOT NULL UNIQUE,
  `eventType` VARCHAR(255) NOT NULL,
  `payload` JSON NOT NULL,
  `processedAt` DATETIME NULL,
  `status` VARCHAR(50) NOT NULL DEFAULT 'received',
  `errorMessage` TEXT NULL,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_event_type` (`eventType`),
  INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 1d. CardDetails — add Authorize.Net profile IDs
ALTER TABLE `cardDetails`
  ADD COLUMN `authorizeCustomerProfileId` VARCHAR(255) NULL AFTER `paymentProfileId`,
  ADD COLUMN `authorizePaymentProfileId` VARCHAR(255) NULL AFTER `authorizeCustomerProfileId`;
