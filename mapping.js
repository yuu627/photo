/* mapping.js
 * このファイルはアプリの「対応表」タブから書き出されました（2026/09/04 23:22:00）。
 * バーコード⇔写真の対応表です。書き方の詳細はREADME.mdを参照してください。
 * 直接編集する場合も、この配列の形式（barcode / photo または photos / label）を保ってください。
 */

window.BARCODE_MAP = [
  {
    "barcode": "SAMPLE-0001",
    "photo": "photos/sample_001.jpg",
    "label": "サンプル商品A"
  },
  {
    "barcode": "SAMPLE-0002",
    "photos": [
      "photos/sample_002.jpg",
      "photos/sample_003.jpg"
    ],
    "label": "サンプル商品B（複数枚の例）"
  },
  {
    "barcode": "SAMPLE-0003",
    "photo": "photos/sample_003.jpg",
    "label": "サンプル商品C"
  },
  {
    "barcode": "000001",
    "label": "test",
    "photo": "photos/temp_tmtmz4bnkuk9255_0.jpg"
  }
];
