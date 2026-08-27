# Testdateien

`foto-mit-metadaten.jpg` ist ein absichtlich kleines, verrauschtes JPEG mit
vollständigem EXIF-Satz: GPS-Koordinaten, Kameramodell, Seriennummer,
Aufnahmezeit. Genau so ein Foto kommt aus einem Handy.

Klein und verrauscht ist Absicht: In dieser Größe war das Original früher
kleiner als die neu berechnete Fassung, und die App reichte es deshalb
unverändert weiter – mitsamt Standort. Der Test in
`test/e2e/privacy.spec.js` stellt sicher, dass das nicht zurückkommt.
