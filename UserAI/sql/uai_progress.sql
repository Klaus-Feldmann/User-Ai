CREATE TABLE /*_*/uai_progress (
  uaip_owner INT UNSIGNED NOT NULL,
  uaip_actor INT UNSIGNED NOT NULL,
  uaip_task VARBINARY(120) NOT NULL,
  uaip_status VARBINARY(12) NOT NULL,
  uaip_summary VARBINARY(480) NOT NULL,
  uaip_updated BIGINT UNSIGNED NOT NULL,
  uaip_connection VARBINARY(32) DEFAULT NULL,
  uaip_read_notice VARBINARY(240) DEFAULT NULL,
  uaip_write_notice VARBINARY(240) DEFAULT NULL,
  uaip_report_token VARBINARY(36) DEFAULT NULL,
  PRIMARY KEY (uaip_owner, uaip_actor)
) /*$wgDBTableOptions*/;
