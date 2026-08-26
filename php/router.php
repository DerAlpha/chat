<?php
/**
 * Nur für den eingebauten PHP-Server (`php -S`), damit sich Tests und lokale
 * Entwicklung so verhalten wie später der Apache mit .htaccess.
 *
 *   php -S 127.0.0.1:8000 -t <docroot> php/router.php
 */
declare(strict_types=1);

// -t <dir> setzt DOCUMENT_ROOT; $_ENV waere je nach variables_order leer.
$docRoot = rtrim((string) ($_SERVER['DOCUMENT_ROOT'] ?: getcwd()), '/');
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';

if (str_starts_with($path, '/api/') || $path === '/api') {
    $_SERVER['SCRIPT_NAME'] = '/api/index.php';
    $_SERVER['SCRIPT_FILENAME'] = $docRoot . '/api/index.php';
    require $docRoot . '/api/index.php';
    return true;
}

$file = $docRoot . $path;
if ($path !== '/' && is_file($file)) {
    return false; // vom eingebauten Server ausliefern lassen
}
if (is_dir($file) && is_file(rtrim($file, '/') . '/index.html')) {
    $file = rtrim($file, '/') . '/index.html';
} else {
    $file = $docRoot . '/index.html';
}
header('Content-Type: text/html; charset=utf-8');
readfile($file);
return true;
