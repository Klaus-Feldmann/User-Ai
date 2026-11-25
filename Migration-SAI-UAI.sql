-- MariaDB 10.6.1 oder neuer. In der Wiki-Datenbank ausführen.
-- Bei MediaWiki-Tabellenpräfix den Wert entsprechend $wgDBprefix setzen.
SET @mw_prefix = '';
DELIMITER //
BEGIN NOT ATOMIC
  IF DATABASE() IS NULL OR @mw_prefix IS NULL OR @mw_prefix NOT REGEXP '^[A-Za-z0-9_]*$' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Wiki-Datenbank und Tabellenpraefix pruefen';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'sai_connection')) + (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'uai_connection')) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tabellenbestand sai_connection / uai_connection uneindeutig';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'sai_connection')) = 1 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = CONCAT(@mw_prefix, 'sai_connection') AND COLUMN_NAME IN ('saic_id', 'saic_proof', 'saic_bearer', 'saic_owner', 'saic_actor', 'saic_consumer', 'saic_application', 'saic_state', 'saic_expires')) <> 9 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Spaltenbestand von sai_connection pruefen';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'uai_connection')) = 1 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = CONCAT(@mw_prefix, 'uai_connection') AND COLUMN_NAME IN ('uaic_id', 'uaic_proof', 'uaic_bearer', 'uaic_owner', 'uaic_actor', 'uaic_consumer', 'uaic_application', 'uaic_state', 'uaic_expires')) <> 9 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Spaltenbestand von uai_connection pruefen';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'sai_order_counter')) + (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'uai_order_counter')) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tabellenbestand sai_order_counter / uai_order_counter uneindeutig';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'sai_order_counter')) = 1 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = CONCAT(@mw_prefix, 'sai_order_counter') AND COLUMN_NAME IN ('saioc_actor', 'saioc_number')) <> 2 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Spaltenbestand von sai_order_counter pruefen';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'uai_order_counter')) = 1 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = CONCAT(@mw_prefix, 'uai_order_counter') AND COLUMN_NAME IN ('uaioc_actor', 'uaioc_number')) <> 2 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Spaltenbestand von uai_order_counter pruefen';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'sai_progress')) + (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'uai_progress')) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tabellenbestand sai_progress / uai_progress uneindeutig';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'sai_progress')) = 1 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = CONCAT(@mw_prefix, 'sai_progress') AND COLUMN_NAME IN ('saip_owner', 'saip_actor', 'saip_task', 'saip_status', 'saip_summary', 'saip_updated', 'saip_connection', 'saip_read_notice', 'saip_write_notice', 'saip_report_token')) <> 10 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Spaltenbestand von sai_progress pruefen';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'uai_progress')) = 1 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = CONCAT(@mw_prefix, 'uai_progress') AND COLUMN_NAME IN ('uaip_owner', 'uaip_actor', 'uaip_task', 'uaip_status', 'uaip_summary', 'uaip_updated', 'uaip_connection', 'uaip_read_notice', 'uaip_write_notice', 'uaip_report_token')) <> 10 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Spaltenbestand von uai_progress pruefen';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'sai_connection')) = 1 THEN
    SELECT MIN(INDEX_NAME) INTO @expiry_idx FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = CONCAT(@mw_prefix, 'sai_connection') AND INDEX_NAME IN ('saic_expiry', CONCAT(@mw_prefix, 'saic_expiry')) AND COLUMN_NAME = 'saic_expires';
    IF @expiry_idx IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ablaufindex fehlt'; END IF;
    SET @ddl = CONCAT('ALTER TABLE `', @mw_prefix, 'sai_connection` RENAME COLUMN `saic_id` TO `uaic_id`, RENAME COLUMN `saic_proof` TO `uaic_proof`, RENAME COLUMN `saic_bearer` TO `uaic_bearer`, RENAME COLUMN `saic_owner` TO `uaic_owner`, RENAME COLUMN `saic_actor` TO `uaic_actor`, RENAME COLUMN `saic_consumer` TO `uaic_consumer`, RENAME COLUMN `saic_application` TO `uaic_application`, RENAME COLUMN `saic_state` TO `uaic_state`, RENAME COLUMN `saic_expires` TO `uaic_expires`, RENAME INDEX `', @expiry_idx, '` TO `', REPLACE(@expiry_idx, 'saic_expiry', 'uaic_expiry'), '`, RENAME TO `', @mw_prefix, 'uai_connection`');
    PREPARE uai_ddl FROM @ddl;
    EXECUTE uai_ddl;
    DEALLOCATE PREPARE uai_ddl;
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'sai_order_counter')) = 1 THEN
    SET @ddl = CONCAT('ALTER TABLE `', @mw_prefix, 'sai_order_counter` RENAME COLUMN `saioc_actor` TO `uaioc_actor`, RENAME COLUMN `saioc_number` TO `uaioc_number`, RENAME TO `', @mw_prefix, 'uai_order_counter`');
    PREPARE uai_ddl FROM @ddl;
    EXECUTE uai_ddl;
    DEALLOCATE PREPARE uai_ddl;
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = CONCAT(@mw_prefix, 'sai_progress')) = 1 THEN
    SET @ddl = CONCAT('ALTER TABLE `', @mw_prefix, 'sai_progress` RENAME COLUMN `saip_owner` TO `uaip_owner`, RENAME COLUMN `saip_actor` TO `uaip_actor`, RENAME COLUMN `saip_task` TO `uaip_task`, RENAME COLUMN `saip_status` TO `uaip_status`, RENAME COLUMN `saip_summary` TO `uaip_summary`, RENAME COLUMN `saip_updated` TO `uaip_updated`, RENAME COLUMN `saip_connection` TO `uaip_connection`, RENAME COLUMN `saip_read_notice` TO `uaip_read_notice`, RENAME COLUMN `saip_write_notice` TO `uaip_write_notice`, RENAME COLUMN `saip_report_token` TO `uaip_report_token`, RENAME TO `', @mw_prefix, 'uai_progress`');
    PREPARE uai_ddl FROM @ddl;
    EXECUTE uai_ddl;
    DEALLOCATE PREPARE uai_ddl;
  END IF;
END//
DELIMITER ;
