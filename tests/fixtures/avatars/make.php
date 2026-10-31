<?php
// Regenerates the avatar test images of this directory (plan §11, tests/profiles.http.test.mjs and tests/community.test.mjs).
// Run once with PHP GD (WebP support) and commit the files: php tests/fixtures/avatars/make.php
//   photo.webp 300×200, photo.jpg 320×240, photo.png 256×256 with transparency  → accepted
//   exif-gps.jpg  320×200, left half red, right half blue, EXIF with Orientation 6, an ImageDescription marker and a GPS
//                 block (52°13'N); the server must rotate it and drop every byte of the metadata
//   trailing.jpg  a valid JPEG followed by PHP and HTML text: accepted, the appended text is gone after re-encoding
//   polyglot.jpg  HTML/JS text with JPEG bytes after it: not an image by content → 415
//   vector.svg, anim.gif → 415; tiny.png 32×32 and wide.png 3000×64 → 422 (dimensions)
// The "too large" upload (> 512 KB) is built by the test at run time to keep the repository small.
declare(strict_types=1);
if(PHP_SAPI!=='cli')exit(1);
$dir=__DIR__;
function canvas(int $w,int $h,bool $split=false):GdImage{
 $im=imagecreatetruecolor($w,$h);imagefill($im,0,0,imagecolorallocate($im,30,120,200));
 if($split){imagefilledrectangle($im,0,0,intdiv($w,2)-1,$h-1,imagecolorallocate($im,220,20,20));imagefilledrectangle($im,intdiv($w,2),0,$w-1,$h-1,imagecolorallocate($im,20,20,220));}
 else for($i=0;$i<8;$i++)imagefilledellipse($im,intdiv($w*($i+1),9),intdiv($h,2),intdiv($w,6),intdiv($h,3),imagecolorallocate($im,30*$i,200-20*$i,90));
 return $im;
}
function bytes(callable $fn):string{ob_start();$fn();return (string)ob_get_clean();}
$webp=canvas(300,200);file_put_contents("$dir/photo.webp",bytes(fn()=>imagewebp($webp,null,80)));
$jpg=canvas(320,240);$jpeg=bytes(fn()=>imagejpeg($jpg,null,85));file_put_contents("$dir/photo.jpg",$jpeg);
$png=imagecreatetruecolor(256,256);imagesavealpha($png,true);imagefill($png,0,0,imagecolorallocatealpha($png,0,0,0,127));imagefilledellipse($png,128,128,200,200,imagecolorallocate($png,0,114,188));
file_put_contents("$dir/photo.png",bytes(fn()=>imagepng($png)));
// EXIF (big-endian TIFF): IFD0 = ImageDescription, Orientation, GPS IFD pointer; GPS IFD = GPSLatitudeRef 'N', GPSLatitude 52/1 13/1 0/1.
$desc="MatBravoSecretExifMarker\0";$ifd0=8;$n0=3;$after0=$ifd0+2+$n0*12+4;$descAt=$after0;$gpsAt=$descAt+strlen($desc);$n1=2;$ratAt=$gpsAt+2+$n1*12+4;
$e=fn(int $tag,int $type,int $count,string $value)=>pack('nnN',$tag,$type,$count).str_pad($value,4,"\0");
$tiff='MM'.pack('nN',42,$ifd0).pack('n',$n0).$e(0x010E,2,strlen($desc),pack('N',$descAt)).$e(0x0112,3,1,pack('n',6)).$e(0x8825,4,1,pack('N',$gpsAt)).pack('N',0)
 .$desc.pack('n',$n1).$e(0x0001,2,2,"N\0").$e(0x0002,5,3,pack('N',$ratAt)).pack('N',0).pack('N6',52,1,13,1,0,1);
$app1="\xFF\xE1".pack('n',strlen($tiff)+8)."Exif\0\0".$tiff;
$split=canvas(320,200,true);$raw=bytes(fn()=>imagejpeg($split,null,90));
file_put_contents("$dir/exif-gps.jpg",substr($raw,0,2).$app1.substr($raw,2));
file_put_contents("$dir/trailing.jpg",$jpeg."<?php echo 'MatBravoTrailingPayload'; ?><script>alert('MatBravoTrailingPayload')</script>");
file_put_contents("$dir/polyglot.jpg","<!DOCTYPE html><html><body><script>alert(document.cookie)</script></body></html>\n".$jpeg);
file_put_contents("$dir/vector.svg",'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><script>alert(1)</script><circle cx="128" cy="128" r="100" fill="#0072bc"/></svg>'."\n");
$gif=canvas(100,100);file_put_contents("$dir/anim.gif",bytes(fn()=>imagegif($gif)));
$tiny=canvas(32,32);file_put_contents("$dir/tiny.png",bytes(fn()=>imagepng($tiny,null,9)));
$wide=canvas(3000,64);file_put_contents("$dir/wide.png",bytes(fn()=>imagepng($wide,null,9)));
foreach(glob("$dir/*.{webp,jpg,png,svg,gif}",GLOB_BRACE) as $f)printf("%-14s %7d bytes\n",basename($f),filesize($f));
