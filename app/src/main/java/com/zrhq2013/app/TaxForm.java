package com.zrhq2013.app;

public class TaxForm {

    public final String title;
    public final String uploadDate;
    public final String sizeText;
    public final String url;
    public final String fileName;

    public TaxForm(String title, String uploadDate, String sizeText, String url, String fileName) {
        this.title = title;
        this.uploadDate = uploadDate;
        this.sizeText = sizeText;
        this.url = url;
        this.fileName = fileName;
    }
}
