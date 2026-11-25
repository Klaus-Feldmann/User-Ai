CREATE TABLE /*_*/uai_connection (
  uaic_id VARBINARY(32) NOT NULL,
  uaic_proof VARBINARY(64) NOT NULL,
  uaic_bearer VARBINARY(64) NOT NULL,
  uaic_owner INT UNSIGNED NOT NULL,
  uaic_actor INT UNSIGNED NOT NULL,
  uaic_consumer VARBINARY(32) NOT NULL,
  uaic_application VARBINARY(255) NOT NULL,
  uaic_state TINYINT UNSIGNED NOT NULL,
  uaic_expires BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (uaic_id)
) /*$wgDBTableOptions*/;
CREATE INDEX /*i*/uaic_expiry ON /*_*/uai_connection (uaic_expires);
