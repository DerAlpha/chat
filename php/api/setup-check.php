<?php
declare(strict_types=1);

/**
 * Selbstdiagnose nach dem Hochladen.
 *
 * Im Browser aufrufen:  https://deine-domain/api/setup-check.php
 * Sie sagt, ob alles passt - und was zu tun ist, wenn nicht.
 *
 * Danach ruhig löschen; nötig ist sie nur einmal.
 */

require __DIR__ . '/lib/Config.php';

header('Content-Type: text/html; charset=utf-8');
header('X-Robots-Tag: noindex');

$checks = [];
$fail = static function (string $name, string $detail, string $fix): array {
    return ['name' => $name, 'ok' => false, 'detail' => $detail, 'fix' => $fix];
};
$pass = static function (string $name, string $detail): array {
    return ['name' => $name, 'ok' => true, 'detail' => $detail, 'fix' => ''];
};

// --- PHP-Version -----------------------------------------------------------
$checks[] = PHP_VERSION_ID >= 80100
    ? $pass('PHP-Version', PHP_VERSION)
    : $fail('PHP-Version', PHP_VERSION . ' ist zu alt',
        'Im lima-city-Panel unter Domains die PHP-Version auf 8.1 oder neuer stellen.');

// --- Erweiterungen ---------------------------------------------------------
foreach (['json', 'mbstring'] as $ext) {
    $checks[] = extension_loaded($ext)
        ? $pass("Erweiterung $ext", 'vorhanden')
        : $fail("Erweiterung $ext", 'fehlt', "Beim Hoster die PHP-Erweiterung $ext aktivieren lassen.");
}
$checks[] = function_exists('random_bytes')
    ? $pass('Zufallsquelle', 'random_bytes() vorhanden')
    : $fail('Zufallsquelle', 'random_bytes() fehlt', 'Ohne sichere Zufallszahlen läuft der Dienst nicht.');

// --- Datenordner -----------------------------------------------------------
try {
    $config = Config::get();
    $dir = $config->dataDir;
    $outside = !str_starts_with(realpath($dir) ?: $dir, realpath(dirname(__DIR__)) ?: dirname(__DIR__));
    if (!is_dir($dir)) {
        $checks[] = $fail('Datenordner', "$dir gibt es nicht", 'Ordner anlegen und beschreibbar machen (chmod 770).');
    } elseif (!is_writable($dir)) {
        $checks[] = $fail('Datenordner', "$dir ist nicht beschreibbar", 'Rechte auf 770 setzen.');
    } else {
        $probe = $dir . '/.probe';
        $written = @file_put_contents($probe, 'ok') !== false;
        @unlink($probe);
        $checks[] = $written
            ? $pass('Datenordner', $dir . ($outside ? ' (ausserhalb des Webverzeichnisses – gut)' : ' (im Webverzeichnis – per .htaccess geschützt)'))
            : $fail('Datenordner', "in $dir lässt sich nichts schreiben", 'Schreibrechte prüfen.');
    }
} catch (Throwable $error) {
    $checks[] = $fail('Datenordner', $error->getMessage(), 'Pfad in api/lib/config.local.php setzen.');
}

// --- Upload-Grenzen --------------------------------------------------------
$toBytes = static function (string $value): int {
    $value = trim($value);
    $unit = strtolower($value[strlen($value) - 1] ?? '');
    $number = (int) $value;
    return match ($unit) { 'g' => $number * 1024 ** 3, 'm' => $number * 1024 ** 2, 'k' => $number * 1024, default => $number };
};
$post = $toBytes((string) ini_get('post_max_size'));
$needed = 13 * 1024 * 1024;
$checks[] = $post >= $needed
    ? $pass('Upload-Grenze', ini_get('post_max_size') . ' – reicht für 12-MB-Anhänge')
    : $fail('Upload-Grenze', ini_get('post_max_size') . ' ist knapp',
        'In .user.ini post_max_size und upload_max_filesize auf 16M setzen – oder MAX_BLOB_BYTES kleiner wählen.');

// --- Wartezeit fürs Abholen -----------------------------------------------
$limit = (int) ini_get('max_execution_time');
$checks[] = $limit === 0 || $limit >= 15
    ? $pass('Laufzeit je Anfrage', ($limit === 0 ? 'unbegrenzt' : $limit . ' s') . ' – Warten auf neue Nachrichten: ' . $config->pollWaitSeconds . ' s')
    : $fail('Laufzeit je Anfrage', $limit . ' s ist sehr kurz',
        'In .user.ini max_execution_time erhöhen. Es läuft auch so, nur werden häufiger Anfragen gestellt.');

// --- Greift .htaccess? -----------------------------------------------------
$rewrite = function_exists('apache_get_modules') ? in_array('mod_rewrite', apache_get_modules(), true) : null;
$checks[] = $rewrite === false
    ? $fail('mod_rewrite', 'nicht aktiv', 'Ohne Rewrite werden API-Adressen nicht gefunden. Beim Hoster nachfragen.')
    : $pass('mod_rewrite', $rewrite === true ? 'aktiv' : 'nicht prüfbar (kein Apache-Modul-Zugriff) – der Test unten zeigt es');

$allOk = !in_array(false, array_column($checks, 'ok'), true);
?>
<!doctype html>
<html lang="de">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flüsterchat – Einrichtung prüfen</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #16202b; }
  h1 { font-size: 1.4rem; }
  .row { display: flex; gap: .75rem; padding: .6rem 0; border-bottom: 1px solid #e6e9ef; align-items: baseline; }
  .mark { font-weight: 700; width: 1.5rem; flex: none; }
  .ok .mark { color: #1f9d55; }
  .no .mark { color: #cf2f2f; }
  .name { font-weight: 600; min-width: 11rem; }
  .fix { color: #cf2f2f; font-size: .9rem; display: block; }
  .verdict { padding: 1rem; border-radius: .6rem; margin: 1.2rem 0; }
  .good { background: #e8f7ee; }
  .bad { background: #fdeaea; }
  code { background: #f1f3f7; padding: .1rem .35rem; border-radius: .25rem; }
</style>
<h1>Flüsterchat – Einrichtung prüfen</h1>

<div class="verdict <?= $allOk ? 'good' : 'bad' ?>">
  <?= $allOk
      ? '<strong>Alles bereit.</strong> Du kannst die Seite aufrufen – und diese Datei danach löschen.'
      : '<strong>Es fehlt noch etwas.</strong> Die rot markierten Punkte unten sagen, was zu tun ist.' ?>
</div>

<?php foreach ($checks as $check): ?>
  <div class="row <?= $check['ok'] ? 'ok' : 'no' ?>">
    <span class="mark"><?= $check['ok'] ? '✓' : '✗' ?></span>
    <span class="name"><?= htmlspecialchars($check['name'], ENT_QUOTES) ?></span>
    <span>
      <?= htmlspecialchars($check['detail'], ENT_QUOTES) ?>
      <?php if (!$check['ok']): ?><span class="fix"><?= htmlspecialchars($check['fix'], ENT_QUOTES) ?></span><?php endif; ?>
    </span>
  </div>
<?php endforeach; ?>

<h2 style="font-size:1.1rem;margin-top:1.6rem">Kurzer Funktionstest</h2>
<p>Diese beiden Adressen sollten JSON zurückgeben:</p>
<ul>
  <li><a href="config"><code>api/config</code></a> – sagt dem Browser, wie er sprechen soll</li>
  <li><a href="healthz"><code>api/healthz</code></a> – Lebenszeichen</li>
</ul>
<p>Kommt dort eine Fehlerseite statt JSON, greift <code>.htaccess</code> nicht
   (oder <code>mod_rewrite</code> fehlt).</p>
