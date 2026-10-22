package com.zrhq2013.app;

import android.content.BroadcastReceiver;
import android.content.Intent;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public class MainActivity extends AppCompatActivity {

    public static final String OFFICIAL_URL =
            "https://etax.chinatax.gov.cn/webstatic/download-service/100009?dmnHafHu=0RHyUWqlqWxCqOPJjoV_L5r_lIULVak3tItx_BUSa8ig1_XPkswA9EMCLFArKQr6RnEr2GuUm3nqJfL_lDaRGqmrrY_LNdCbp0b_fjqawNpv0uEZUPIyvda";

    private static final int TAB_FORMS = 0;
    private static final int TAB_TOOLS = 1;

    private final List<TaxForm> allForms = new ArrayList<>();
    private final List<TaxForm> shownForms = new ArrayList<>();

    private FormAdapter adapter;
    private EditText searchInput;
    private TextView chipForms;
    private TextView chipTools;
    private TextView sectionTitle;
    private LinearLayout emptyView;
    private TextView emptyText;
    private int currentTab = TAB_FORMS;
    private BroadcastReceiver downloadReceiver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        initData();
        initViews();
        applyTab(TAB_FORMS);
    }

    private void initData() {
        allForms.addAll(Arrays.asList(
                new TaxForm(
                        "个人所得税基础信息表（A表）",
                        "2020-07-28",
                        "24 KB",
                        "https://wcdn.etax.chinatax.gov.cn/bbxzdownload/collection/xxcjgl/grsdsjcxxa.zip",
                        "grsdsjcxxa.zip"),
                new TaxForm(
                        "个人所得税基础信息表（B表）",
                        "2020-07-28",
                        "25 KB",
                        "https://wcdn.etax.chinatax.gov.cn/bbxzdownload/collection/xxcjgl/grsdsjcxxb.zip",
                        "grsdsjcxxb.zip")
        ));
    }

    private void initViews() {
        chipForms = findViewById(R.id.chip_forms);
        chipTools = findViewById(R.id.chip_tools);
        sectionTitle = findViewById(R.id.tv_section_title);
        emptyView = findViewById(R.id.empty_view);
        emptyText = findViewById(R.id.tv_empty);
        searchInput = findViewById(R.id.et_search);

        RecyclerView recyclerView = findViewById(R.id.rv_forms);
        recyclerView.setLayoutManager(new LinearLayoutManager(this));
        recyclerView.setHasFixedSize(false);
        adapter = new FormAdapter(form ->
                DownloadCenter.download(MainActivity.this, form.url, form.fileName));
        recyclerView.setAdapter(adapter);

        chipForms.setOnClickListener(v -> applyTab(TAB_FORMS));
        chipTools.setOnClickListener(v -> applyTab(TAB_TOOLS));

        findViewById(R.id.btn_official).setOnClickListener(v ->
                WebViewActivity.start(MainActivity.this, OFFICIAL_URL));

        searchInput.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                filterForms(s.toString());
            }

            @Override
            public void afterTextChanged(Editable s) {
            }
        });

        downloadReceiver = DownloadCenter.registerCompleteReceiver(this);
    }

    private void applyTab(int tab) {
        currentTab = tab;
        chipForms.setSelected(tab == TAB_FORMS);
        chipTools.setSelected(tab == TAB_TOOLS);

        if (tab == TAB_FORMS) {
            sectionTitle.setText(R.string.section_title);
            searchInput.setEnabled(true);
            filterForms(searchInput.getText().toString());
        } else {
            sectionTitle.setText(R.string.tab_tools);
            searchInput.setEnabled(false);
            shownForms.clear();
            adapter.submit(shownForms);
            emptyText.setText(R.string.empty_tools);
            emptyView.setVisibility(View.VISIBLE);
        }
    }

    private void filterForms(String keyword) {
        if (currentTab != TAB_FORMS) {
            return;
        }
        shownForms.clear();
        String key = keyword == null ? "" : keyword.trim();
        for (TaxForm form : allForms) {
            if (key.isEmpty() || form.title.contains(key)) {
                shownForms.add(form);
            }
        }
        adapter.submit(shownForms);
        emptyText.setText(R.string.empty_forms);
        emptyView.setVisibility(shownForms.isEmpty() ? View.VISIBLE : View.GONE);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        DownloadCenter.onRequestPermissionsResult(this, requestCode, grantResults);
    }

    @Override
    protected void onDestroy() {
        DownloadCenter.unregisterCompleteReceiver(this, downloadReceiver);
        super.onDestroy();
    }
}
